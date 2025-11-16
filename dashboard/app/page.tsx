"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import Image from "next/image";
import { deployGlobal, fetchRegions, infer, killRegion } from "../lib/api";

const MIN_REFRESH_TIME = 600;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Region = {
  id: string;
  slug: string;
  display_name: string;
  ip?: string | null;
  status: string;
  latency_ms?: number | null;
  disabled?: boolean;
};

type RegionsResponse = {
  deployment_id?: string;
  regions: Region[];
};

type RegionResult = {
  region_id: string;
  region_slug: string;
  region_name: string;
  latency_ms?: number | null;
  image_url?: string | null;
  engine?: string | null;
  effect?: string | null;
  error?: string | null;
};

type LastResult = {
  prompt?: string;
  image_url?: string;
  region_id?: string;
  region_slug?: string;
  region_name?: string;
  latency_ms?: number;
  effect?: string;
  error?: string;
  results?: RegionResult[];
};

type EventLogItem = {
  id: string;
  timestamp: string;
  message: string;
};

const MODE = (process.env.NEXT_PUBLIC_MODE || "mock").toLowerCase();

function formatTime(date: Date): string {
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  const s = date.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function isKillDisabled(region: Region): boolean {
  return region.status === "down" || region.status === "killed" || !!region.disabled;
}

const EXAMPLE_PROMPTS = [
  "mountain landscape at sunset",
  "futuristic city skyline",
  "ocean waves crashing on beach",
];

export default function Home() {
  const [regions, setRegions] = useState<Region[]>([]);
  const [deploymentId, setDeploymentId] = useState<string | null>(
    MODE === "mock" ? "mock-deployment" : null
  );
  const [isLoadingRegions, setIsLoadingRegions] = useState<boolean>(false);
  const [isDeploying, setIsDeploying] = useState<boolean>(false);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [killingRegion, setKillingRegion] = useState<string | null>(null);

  const [prompt, setPrompt] = useState<string>("");
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [logs, setLogs] = useState<EventLogItem[]>([]);

  // default = Manual (0)
  const [refreshInterval, setRefreshInterval] = useState<number>(0);
  const lastRefreshTimeRef = useRef<number>(0);
  const [isManualRefreshing, setIsManualRefreshing] = useState<boolean>(false);
  const loadingLockRef = useRef<boolean>(false);

  const [progressByRegion, setProgressByRegion] = useState<Record<string, number>>({});
  const progressTimerRef = useRef<number | null>(null);

  const appendLog = useCallback((message: string) => {
    const now = new Date();
    setLogs((prev) => [
      {
        id: `${now.getTime()}-${Math.random().toString(16).slice(2)}`,
        timestamp: formatTime(now),
        message,
      },
      ...prev.slice(0, 50),
    ]);
  }, []);

  const loadRegions = useCallback(
    async (force: boolean = false) => {
      if (loadingLockRef.current && !force) return;

      const now = Date.now();
      const last = lastRefreshTimeRef.current;

      if (!force && now - last < 2000) {
        return;
      }

      loadingLockRef.current = true;
      setIsLoadingRegions(true);

      try {
        const data = (await fetchRegions()) as RegionsResponse;
        if (data.deployment_id) {
          setDeploymentId(data.deployment_id);
        }

        if (Array.isArray(data.regions)) {
          setRegions((currentRegions) => {
            return data.regions.map((newRegion) => {
              const currentRegion = currentRegions.find((r) => r.id === newRegion.id);
              if (
                currentRegion &&
                (currentRegion.status === "killed" || currentRegion.status === "down")
              ) {
                return {
                  ...newRegion,
                  status: "killed",
                  latency_ms: null,
                };
              }
              return newRegion;
            });
          });
        } else {
          setRegions([]);
        }

        lastRefreshTimeRef.current = now;
        setError(null);
      } catch (e) {
        const msg = (e as Error).message || "Unknown error";
        setError("Failed to load regions");
        appendLog(`Failed to load regions: ${msg}`);
      } finally {
        setIsLoadingRegions(false);
        loadingLockRef.current = false;
      }
    },
    [appendLog]
  );

  const doSmoothRefreshRef = useRef<(() => Promise<void>) | null>(null);

  doSmoothRefreshRef.current = async () => {
    if (isManualRefreshing) return;

    setIsManualRefreshing(true);
    const start = Date.now();

    await loadRegions(true);

    const elapsed = Date.now() - start;
    if (elapsed < MIN_REFRESH_TIME) {
      await sleep(MIN_REFRESH_TIME - elapsed);
    }

    setIsManualRefreshing(false);
  };

  useEffect(() => {
    if (refreshInterval === 0) return;

    const interval = setInterval(() => {
      doSmoothRefreshRef.current?.();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [refreshInterval]);

  const hasHealthyRegion = useMemo(
    () => regions.some((r) => r.status === "healthy" && !r.disabled),
    [regions]
  );

  const healthyCount = useMemo(
    () => regions.filter((r) => r.status === "healthy").length,
    [regions]
  );

  const killedCount = useMemo(
    () => regions.filter((r) => r.status === "killed" || r.status === "down").length,
    [regions]
  );

  const pipelineSummary = useMemo(() => {
    if (!lastResult || !lastResult.results || lastResult.results.length === 0) {
      return null;
    }
    const valid = lastResult.results.filter(
      (r) => typeof r.latency_ms === "number"
    ) as RegionResult[];
    if (valid.length === 0) return null;

    const count = valid.length;
    let fastest = valid[0];
    let sum = 0;

    for (const r of valid) {
      const lat = r.latency_ms || 0;
      sum += lat;
      if (
        (r.latency_ms || Number.MAX_SAFE_INTEGER) <
        (fastest.latency_ms || Number.MAX_SAFE_INTEGER)
      ) {
        fastest = r;
      }
    }

    const averageLatency = sum / count;
    const parallelTime = Math.min(...valid.map((r) => r.latency_ms || 0));

    return {
      count,
      fastestName: fastest.region_name || fastest.region_slug,
      fastestLatency: Math.round(fastest.latency_ms || 0),
      averageLatency: Math.round(averageLatency),
      parallelTime: Math.round(parallelTime),
    };
  }, [lastResult]);

  const handleDeploy = useCallback(async () => {
    if (isDeploying) return;

    setIsDeploying(true);
    setError(null);
    appendLog("Deploying global infrastructure...");

    try {
      const data = await deployGlobal();
      const newDeploymentId =
        data?.deployment_id || (MODE === "mock" ? "mock-deployment" : null);

      if (newDeploymentId) {
        setDeploymentId(newDeploymentId);
        appendLog(`Deployment started: ${newDeploymentId}`);
      }

      if (data && Array.isArray(data.regions)) {
        setRegions(data.regions);
        appendLog(`Deployed ${data.regions.length} regions`);
      } else {
        await loadRegions(true);
      }
    } catch (e) {
      const msg = (e as Error).message || "Unknown error";
      setError("Deployment failed");
      appendLog(`Deploy failed: ${msg}`);
    } finally {
      setIsDeploying(false);
    }
  }, [appendLog, isDeploying, loadRegions]);

  const handleKill = useCallback(
    async (region: Region) => {
      if (isKillDisabled(region) || killingRegion) return;

      setKillingRegion(region.id);
      appendLog(`Killing region: ${region.display_name}`);
      setError(null);

      try {
        await killRegion(region.id);

        setRegions((currentRegions) =>
          currentRegions.map((r) =>
            r.id === region.id
              ? {
                  ...r,
                  status: "killed",
                  latency_ms: null,
                }
              : r
          )
        );

        appendLog(`Region killed: ${region.display_name}`);

        setTimeout(() => {
          loadRegions(true);
        }, 1000);
      } catch (e) {
        const msg = (e as Error).message || "Unknown error";
        setError("Failed to kill region");
        appendLog(`Kill failed: ${msg}`);
      } finally {
        setKillingRegion(null);
      }
    },
    [appendLog, loadRegions, killingRegion]
  );

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() || isGenerating) return;

    setIsGenerating(true);
    setError(null);
    setLastResult(null);

    if (progressTimerRef.current !== null) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }

    const activeRegions = regions.filter(
      (r) => r.status === "healthy" && !r.disabled
    );
    const initialProgress: Record<string, number> = {};
    activeRegions.forEach((r) => {
      initialProgress[r.id] = 5 + Math.random() * 15;
    });
    setProgressByRegion(initialProgress);

    if (activeRegions.length > 0) {
      progressTimerRef.current = window.setInterval(() => {
        setProgressByRegion((prev) => {
          const next: Record<string, number> = { ...prev };
          Object.keys(next).forEach((id) => {
            if (next[id] < 95) {
              next[id] = Math.min(95, next[id] + 5 + Math.random() * 10);
            }
          });
          return next;
        });
      }, 250);
    }

    const trimmedPrompt = prompt.trim();
    appendLog(`Generating: "${trimmedPrompt}"`);

    try {
      const data = (await infer(trimmedPrompt)) as LastResult;
      const finalResult: LastResult = {
        ...data,
        prompt: trimmedPrompt,
      };

      setLastResult(finalResult);

      if (!data.error && data.results && data.results.length > 0) {
        const summary = data.results
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((r: any) => {
            const eff = r.effect || r.engine || "n/a";
            const lat =
              r.latency_ms != null ? `${Math.round(r.latency_ms)}ms` : "fail";
            return `${r.region_slug}:${eff}(${lat})`;
          })
          .join(", ");

        appendLog(`Multi-region pipeline → ${summary}`);
      }

      if (data.error) {
        appendLog(`Generation error: ${data.error}`);
      } else {
        const regionLabel = data.region_name || data.region_slug || "unknown";
        const latency = data.latency_ms || 0;
        appendLog(`Generated from ${regionLabel} (${Math.round(latency)}ms)`);
      }
    } catch (e) {
      const msg = (e as Error).message || "Unknown error";
      setLastResult({
        prompt: trimmedPrompt,
        error: "Service unavailable",
      });
      setError("Generation failed");
      appendLog(`Generation failed: ${msg}`);
    } finally {
      if (progressTimerRef.current !== null) {
        window.clearInterval(progressTimerRef.current);
        progressTimerRef.current = null;
      }
      setProgressByRegion({});
      setIsGenerating(false);
    }
  }, [appendLog, isGenerating, prompt, regions]);

  const handleExamplePrompt = useCallback((examplePrompt: string) => {
    setPrompt(examplePrompt);
  }, []);

  const handleManualRefresh = useCallback(async () => {
    await doSmoothRefreshRef.current?.();
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-50">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white sm:text-4xl">
              <span className="bg-gradient-to-r from-sky-400 to-emerald-400 bg-clip-text text-transparent">
                InfraZero
              </span>
            </h1>
            <p className="mt-2 text-sm text-slate-300">
              Global AI deployment • Auto-failover • Zero downtime
            </p>
            {deploymentId && (
              <p className="mt-2 text-xs text-slate-400">
                Deployment:{" "}
                <span className="font-mono text-sky-300">{deploymentId}</span>
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                MODE === "mock"
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                  : "bg-purple-500/20 text-purple-300 border border-purple-500/30"
              }`}
            >
              <span className="mr-1.5 h-2 w-2 rounded-full bg-current" />
              {MODE === "mock" ? "Local Demo" : "Vultr Live"}
            </span>
            {error && (
              <span className="max-w-xs rounded-lg bg-red-500/10 border border-red-500/30 px-2 py-1 text-xs text-red-300">
                {error}
              </span>
            )}
          </div>
        </header>

        <div className="mb-6 grid grid-cols-4 gap-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
            <p className="text-xs text-slate-400">Regions</p>
            <p className="text-2xl font-bold text-white">{regions.length}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
            <p className="text-xs text-slate-400">Healthy</p>
            <p className="text-2xl font-bold text-emerald-400">{healthyCount}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
            <p className="text-xs text-slate-400">Killed</p>
            <p className="text-2xl font-bold text-red-400">{killedCount}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
            <p className="text-xs text-slate-400">Status</p>
            <p className="text-2xl font-bold text-sky-400">
              {hasHealthyRegion ? "Online" : "Offline"}
            </p>
          </div>
        </div>

        <section className="mb-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <h2 className="mb-3 text-base font-semibold text-slate-100">
              Orchestration
            </h2>
            <p className="mb-4 text-sm text-slate-400">
              Deploy globally, kill regions live to test failover.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={handleDeploy}
                disabled={isDeploying}
                className={`rounded-xl px-5 py-2.5 text-sm font-semibold transition ${
                  isDeploying
                    ? "bg-sky-700 text-sky-200 cursor-wait"
                    : "bg-sky-600 text-white hover:bg-sky-500"
                }`}
              >
                {isDeploying ? "Deploying..." : "Deploy Global"}
              </button>
              <button
                onClick={handleManualRefresh}
                disabled={isManualRefreshing}
                className="rounded-xl border border-slate-600 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-100 hover:bg-slate-700/80 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isManualRefreshing ? "Refreshing..." : "Refresh"}
              </button>

              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-400">Auto-refresh:</label>
                <select
                  value={refreshInterval}
                  onChange={(e) => setRefreshInterval(Number(e.target.value))}
                  className="rounded-lg border border-slate-600 bg-slate-800/60 px-2 py-1 text-xs text-slate-100"
                >
                  <option value="0">Manual</option>
                  <option value="5000">5s</option>
                  <option value="10000">10s</option>
                  <option value="15000">15s</option>
                  <option value="30000">30s</option>
                </select>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <h2 className="mb-3 text-base font-semibold text-slate-100">
              Image Generation
            </h2>
            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-xs text-slate-300">
                  Prompt
                </label>
                <textarea
                  rows={2}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleGenerate();
                    }
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                  placeholder="Describe what you want to generate..."
                />
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {EXAMPLE_PROMPTS.map((example, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleExamplePrompt(example)}
                      className="rounded-lg border border-slate-700 bg-slate-800/50 px-2 py-1 text-[10px] text-slate-400 hover:bg-slate-700/50 transition"
                    >
                      {example}
                    </button>
                  ))}
                  <button
                    onClick={() => {
                      const random =
                        EXAMPLE_PROMPTS[
                          Math.floor(Math.random() * EXAMPLE_PROMPTS.length)
                        ];
                      setPrompt(random);
                    }}
                    className="ml-1 rounded-lg border border-emerald-600 bg-emerald-600/10 px-2 py-1 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-600/30 transition"
                  >
                    🎲 Random
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating || !prompt.trim() || !hasHealthyRegion}
                  className={`rounded-xl px-5 py-2.5 text-sm font-semibold transition ${
                    isGenerating || !prompt.trim() || !hasHealthyRegion
                      ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                      : "bg-emerald-600 text-white hover:bg-emerald-500"
                  }`}
                >
                  {isGenerating ? "Generating..." : "Generate"}
                </button>
                <div className="text-xs text-slate-400">
                  {healthyCount > 0 ? (
                    <span className="text-emerald-400">{healthyCount} ready</span>
                  ) : (
                    <span className="text-red-400">No regions</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid flex-1 gap-6 lg:grid-cols-[1.5fr,1fr]">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-100">Regions</h2>
              <span className="text-xs text-slate-500">
                {healthyCount} healthy, {killedCount} killed
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {regions.map((region) => (
                <div
                  key={region.id}
                  className={`rounded-xl border ${
                    region.status === "killed" || region.status === "down"
                      ? "border-red-500/50 bg-red-900/20"
                      : "border-slate-700/50 bg-slate-900/90"
                  } p-4 transition-all`}
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-slate-50">
                          {region.display_name}
                        </p>
                        <p className="text-xs font-mono uppercase text-slate-400">
                          {region.slug}
                        </p>
                      </div>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          region.status === "healthy"
                            ? "bg-emerald-400/20 text-emerald-300 border border-emerald-400/30"
                            : region.status === "starting"
                            ? "bg-amber-400/20 text-amber-300 border border-amber-400/30"
                            : "bg-red-400/20 text-red-300 border border-red-400/30"
                        }`}
                      >
                        <span className="mr-1 h-1.5 w-1.5 rounded-full bg-current" />
                        {region.status}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400">
                      <p>
                        Network Latency:{" "}
                        <span className="font-mono text-sky-300">
                          {region.status === "killed" || region.status === "down"
                            ? "—"
                            : typeof region.latency_ms === "number"
                            ? `${Math.round(region.latency_ms)}ms`
                            : "—"}
                        </span>
                      </p>
                    </div>
                  </div>
                  <div className="mt-4">
                    <button
                      onClick={() => handleKill(region)}
                      disabled={isKillDisabled(region) || killingRegion !== null}
                      className={`w-full rounded-lg px-3 py-2 text-xs font-semibold transition ${
                        isKillDisabled(region) || killingRegion !== null
                          ? "border border-slate-700 bg-slate-900/50 text-slate-500 cursor-not-allowed"
                          : "border border-red-500/50 bg-red-600/20 text-red-300 hover:bg-red-600/40"
                      }`}
                    >
                      {killingRegion === region.id
                        ? "Killing..."
                        : region.status === "killed" || region.status === "down"
                        ? "Killed"
                        : "Kill Region"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
              <h2 className="mb-3 text-base font-semibold text-slate-100">Result</h2>

              {isGenerating && Object.keys(progressByRegion).length > 0 && (
                <div className="mb-3 rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-xs">
                  <p className="mb-2 text-slate-300">
                    Processing across {Object.keys(progressByRegion).length} regions...
                  </p>
                  <div className="space-y-1.5">
                    {Object.entries(progressByRegion).map(([id, value]) => {
                      const region = regions.find((r) => r.id === id);
                      const label = region ? region.display_name : id;
                      return (
                        <div key={id}>
                          <div className="flex justify-between text-[11px] text-slate-400">
                            <span>{label}</span>
                            <span>{Math.round(value)}%</span>
                          </div>
                          <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                            <div
                              className="h-full bg-sky-500 transition-all"
                              style={{ width: `${Math.min(100, value)}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {lastResult ? (
                <div className="space-y-3">
                  {!lastResult.error && (
                    <div className="text-xs text-slate-400 space-y-1">
                      <p>
                        Primary result from{" "}
                        <span className="font-semibold text-sky-300">
                          {lastResult.region_name || lastResult.region_slug}
                        </span>
                      </p>
                      {lastResult.effect && (
                        <p>
                          Effect:{" "}
                          <span className="font-mono text-emerald-300">
                            {lastResult.effect}
                          </span>
                        </p>
                      )}
                      {typeof lastResult.latency_ms === "number" && (
                        <p>
                          Total pipeline time:{" "}
                          <span className="font-mono text-emerald-300">
                            {Math.round(lastResult.latency_ms)}ms
                          </span>
                        </p>
                      )}
                    </div>
                  )}

                  {lastResult.image_url && (
                    <div className="flex justify-center">
                      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
                        <Image
                          src={lastResult.image_url}
                          alt="Generated"
                          width={768}
                          height={768}
                          className="w-full max-w-md object-cover rounded-xl"
                          unoptimized
                        />
                      </div>
                    </div>
                  )}

                  {lastResult.results && lastResult.results.length > 0 && (
                    <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
                      <h3 className="mb-2 text-sm font-semibold text-slate-100">
                        Multi-region pipeline comparison
                      </h3>
                      <p className="mb-3 text-xs text-slate-400">
                        Same base image processed in parallel across all regions.
                      </p>
                      <div className="grid gap-3 sm:grid-cols-3">
                        {lastResult.results.map((r) => {
                          const isWinner = r.region_id === lastResult.region_id;
                          return (
                            <div
                              key={r.region_id}
                              className={`rounded-xl border p-2 ${
                                isWinner
                                  ? "border-emerald-500/70 bg-emerald-500/5 shadow-[0_0_0_1px_rgba(16,185,129,0.6)]"
                                  : "border-slate-700/60 bg-slate-900/80"
                              }`}
                            >
                              {r.image_url && (
                                <div className="mb-2 overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
                                  <Image
                                    src={r.image_url}
                                    alt={r.region_name}
                                    width={256}
                                    height={256}
                                    className="w-full object-cover"
                                    unoptimized
                                  />
                                </div>
                              )}
                              <p className="text-[11px] font-semibold text-slate-100">
                                {r.region_name}{" "}
                                <span className="text-slate-500">
                                  ({r.region_slug})
                                </span>
                                {isWinner && (
                                  <span className="ml-1 inline-flex items-center rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">
                                    🏆 FASTEST
                                  </span>
                                )}
                              </p>
                              <p className="text-[11px] text-slate-400">
                                Effect:{" "}
                                <span className="font-mono text-sky-300">
                                  {r.effect || r.engine || "n/a"}
                                </span>
                              </p>
                              <p className="text-[11px] text-slate-400">
                                Latency:{" "}
                                <span className="font-mono text-emerald-300">
                                  {r.latency_ms != null
                                    ? `${Math.round(r.latency_ms)}ms`
                                    : "failed"}
                                </span>
                              </p>
                            </div>
                          );
                        })}
                      </div>

                      {pipelineSummary && (
                        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/80 p-3 text-xs">
                          <p className="mb-2 font-semibold text-slate-100">
                            Pipeline summary
                          </p>
                          <p className="text-slate-400">
                            Regions processed:{" "}
                            <span className="font-mono text-slate-100">
                              {pipelineSummary.count}
                            </span>
                          </p>
                          <p className="text-slate-400">
                            Fastest:{" "}
                            <span className="font-mono text-emerald-300">
                              {pipelineSummary.fastestName} (
                              {pipelineSummary.fastestLatency}ms)
                            </span>
                          </p>
                          <p className="text-slate-400">
                            Average latency:{" "}
                            <span className="font-mono text-sky-300">
                              {pipelineSummary.averageLatency}ms
                            </span>
                          </p>
                          <p className="text-slate-400">
                            Total parallel time:{" "}
                            <span className="font-mono text-amber-300">
                              {pipelineSummary.parallelTime}ms
                            </span>
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {lastResult.error && (
                    <p className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-300">
                      {lastResult.error}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-400">
                  Generate an image to see results
                </p>
              )}
            </div>

            <div className="flex-1 rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-100">Event Log</h2>
                <button
                  onClick={() => setLogs([])}
                  className="text-xs text-slate-500 hover:text-slate-300 transition"
                >
                  Clear
                </button>
              </div>
              <div className="h-64 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/80 p-3 font-mono text-xs">
                {logs.length === 0 ? (
                  <p className="text-slate-500">Events will appear here...</p>
                ) : (
                  <ul className="space-y-1">
                    {logs.map((log) => (
                      <li key={log.id} className="text-slate-300">
                        <span className="text-slate-500">[{log.timestamp}]</span>{" "}
                        {log.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
