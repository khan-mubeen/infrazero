"use client";

import { useEffect, useState } from "react";
import { fetchRegions, deployGlobal, infer, killRegion } from "../lib/api";

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
  deployment_id?: string | null;
  regions: Region[];
};

type InferResult = {
  prompt?: string;
  image_url?: string;
  region_id?: string;
  region_slug?: string;
  latency_ms?: number;
  error?: string;
};

type LogItem = {
  id: string;
  time: string;
  message: string;
};

const MODE = (process.env.NEXT_PUBLIC_MODE || "mock").toLowerCase();

function formatTime(d: Date) {
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export default function Home() {
  const [regions, setRegions] = useState<Region[]>([]);
  const [deploymentId, setDeploymentId] = useState<string | null>(
    MODE === "mock" ? "mock-deployment" : null
  );
  const [loadingRegions, setLoadingRegions] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState<string>("A futuristic data center in space");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [lastResult, setLastResult] = useState<any>(null);
  const [isDeploying, setIsDeploying] = useState<boolean>(false);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);

  const [logs, setLogs] = useState<LogItem[]>([]);

  function appendLog(message: string) {
    const now = new Date();
    setLogs((prev) => [
      {
        id: `${now.getTime()}-${Math.random().toString(16).slice(2)}`,
        time: formatTime(now),
        message,
      },
      ...prev,
    ]);
  }

  async function loadRegions() {
    try {
      setLoadingRegions(true);
      setError(null);

      const data: RegionsResponse = await fetchRegions();

      if (!data || !Array.isArray(data.regions)) {
        throw new Error("Regions payload is not in expected format");
      }

      setRegions(data.regions);

      if (data.deployment_id) {
        setDeploymentId(data.deployment_id);
      }
    } catch (e) {
      const msg = (e as Error).message || "Unknown error";
      setError("Failed to load regions.");
      appendLog(`Failed to load regions: ${msg}`);
    } finally {
      setLoadingRegions(false);
    }
  }

  useEffect(() => {
    loadRegions();
  }, []);

  async function handleDeploy() {
    if (isDeploying) {
      return;
    }

    setIsDeploying(true);
    setError(null);
    appendLog("Starting global deployment…");

    try {
      const data = await deployGlobal();

      const newDeploymentId =
        data?.deployment_id ||
        data?.deploymentId ||
        data?.id ||
        (MODE === "mock" ? "mock-deployment" : null);

      if (newDeploymentId) {
        setDeploymentId(newDeploymentId);
        appendLog(`Deployment started: ${newDeploymentId}`);
      }

      if (data && Array.isArray(data.regions)) {
        setRegions(data.regions);
      } else {
        await loadRegions();
      }
    } catch (e) {
      const msg = (e as Error).message || "unknown error";
      setError("Failed to deploy global. Please check the control-plane.");
      appendLog(`Deploy failed: ${msg}`);
    } finally {
      setIsDeploying(false);
    }
  }

  async function handleKill(region: Region) {
    if (
      region.status === "down" ||
      region.status === "killed" ||
      region.disabled
    ) {
      return;
    }

    appendLog(`Killing region: ${region.display_name} (${region.slug})`);

    try {
      await killRegion(region.id);
      await loadRegions();
      appendLog(`Region killed: ${region.display_name}`);
    } catch (e) {
      const msg = (e as Error).message || "unknown error";
      appendLog(`Failed to kill region ${region.slug}: ${msg}`);
      setError("Failed to kill region. See log for details.");
    }
  }

  async function handleGenerate() {
    if (!prompt.trim() || isGenerating) {
      return;
    }

    setIsGenerating(true);
    setLastResult(null);
    setError(null);

    const cleanPrompt = prompt.trim();
    appendLog(`Infer called with prompt: "${cleanPrompt}"`);

    const startedAt = performance.now();

    try {
      const data: InferResult = await infer(cleanPrompt);
      const duration = Math.round(performance.now() - startedAt);

      if (data.error) {
        appendLog(`Infer error: ${data.error}`);
      } else {
        const regionLabel =
          data.region_slug || data.region_id || "unknown-region";
        appendLog(
          `Infer success from ${regionLabel} in ${
            data.latency_ms ?? duration
          } ms`
        );
      }

      setLastResult({
        ...data,
        latency_ms: data.latency_ms ?? Math.round(performance.now() - startedAt),
      });
    } catch (e) {
      const msg = (e as Error).message || "unknown error";
      appendLog(`Infer failed: ${msg}`);
      setError("Backend is unavailable. Try Deploy Global again.");
    } finally {
      setIsGenerating(false);
    }
  }

  function renderRegionStatus(status: string) {
    const base =
      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";

    if (status === "healthy") {
      return (
        <span className={`${base} bg-emerald-100 text-emerald-800`}>
          <span className="mr-1 h-2 w-2 rounded-full bg-emerald-500" />
          healthy
        </span>
      );
    }

    if (status === "starting") {
      return (
        <span className={`${base} bg-amber-100 text-amber-800`}>
          <span className="mr-1 h-2 w-2 rounded-full bg-amber-500" />
          starting
        </span>
      );
    }

    if (status === "down" || status === "killed") {
      return (
        <span className={`${base} bg-red-100 text-red-800`}>
          <span className="mr-1 h-2 w-2 rounded-full bg-red-500" />
          {status}
        </span>
      );
    }

    return (
      <span className={`${base} bg-slate-200 text-slate-800`}>
        <span className="mr-1 h-2 w-2 rounded-full bg-slate-500" />
        {status}
      </span>
    );
  }

  function renderSkeletonRegions() {
    return (
      <>
        {["ewr", "ams", "sgp"].map((key) => (
          <div
            key={key}
            className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 shadow-sm animate-pulse"
          >
            <div className="mb-3 h-4 w-24 rounded bg-slate-700" />
            <div className="mb-2 h-3 w-32 rounded bg-slate-700" />
            <div className="mb-2 h-3 w-20 rounded bg-slate-700" />
            <div className="mt-4 flex items-center justify-between">
              <div className="h-3 w-16 rounded bg-slate-700" />
              <div className="h-8 w-20 rounded-lg bg-slate-700" />
            </div>
          </div>
        ))}
      </>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        {/* Header */}
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white sm:text-3xl">
              Global AI Studio <span className="text-sky-400">(InfraZero)</span>
            </h1>
            <p className="mt-1 text-sm text-slate-300">
              Deploy a mock multi region setup, kill regions live, and see where
              your generation is served from.
            </p>
            {deploymentId && (
              <p className="mt-2 text-xs text-slate-400">
                Deployment ID:{" "}
                <span className="font-mono text-sky-300">{deploymentId}</span>
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium border ${
                MODE === "mock"
                  ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                  : "bg-purple-100 text-purple-800 border-purple-300"
              }`}
            >
              <span className="mr-1 h-2 w-2 rounded-full bg-current" />
              {MODE === "mock" ? "Mock mode (local only)" : "Vultr mode"}
            </span>
          </div>
        </header>

        {/* Top controls */}
        <section className="mb-6 grid gap-4 md:grid-cols-[1.7fr,2fr]">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-lg shadow-slate-950/60">
            <h2 className="mb-3 text-sm font-semibold text-slate-100">
              Orchestration controls
            </h2>
            <p className="mb-4 text-xs text-slate-400">
              Deploy all regions, then generate. Kill any region to see failover
              in action.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={handleDeploy}
                disabled={isDeploying}
                className={`inline-flex items-center justify-center rounded-xl border border-sky-500 px-4 py-2 text-sm font-medium transition ${
                  isDeploying
                    ? "cursor-wait bg-sky-900/60 text-sky-200"
                    : "bg-sky-600 text-white hover:bg-sky-500"
                }`}
              >
                {isDeploying ? "Deploying…" : "Deploy Global"}
              </button>
              <button
                onClick={loadRegions}
                className="inline-flex items-center justify-center rounded-xl border border-slate-600 bg-slate-800/60 px-3 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700/80"
              >
                Refresh regions
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-lg shadow-slate-950/60">
            <h2 className="mb-3 text-sm font-semibold text-slate-100">
              Image generation
            </h2>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-300">
                  Prompt
                </label>
                <textarea
                  rows={3}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none ring-0 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                  placeholder="Describe the image you want to generate…"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating || !prompt.trim()}
                  className={`inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-medium transition ${
                    isGenerating || !prompt.trim()
                      ? "cursor-not-allowed border border-slate-700 bg-slate-800/60 text-slate-400"
                      : "border border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-500"
                  }`}
                >
                  {isGenerating ? "Generating…" : "Generate"}
                </button>
                {lastResult && (
                  <div className="flex flex-col items-end text-xs text-slate-400">
                    {lastResult.latency_ms != null && (
                      <span>Latency: {lastResult.latency_ms} ms</span>
                    )}
                    {lastResult.region_slug && (
                      <span>Region: {lastResult.region_slug}</span>
                    )}
                    {lastResult.error && (
                      <span className="text-red-400">
                        Error: {lastResult.error}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Main content */}
        <section className="grid flex-1 gap-6 lg:grid-cols-[2fr,1.4fr]">
          {/* Regions */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-lg shadow-slate-950/60">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">
                Regions and health
              </h2>
              <span className="text-xs text-slate-500">
                {loadingRegions
                  ? "Loading regions…"
                  : `${regions.length} region${
                      regions.length === 1 ? "" : "s"
                    }`}
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {loadingRegions
                ? renderSkeletonRegions()
                : regions.map((region) => {
                    const killDisabled =
                      region.status === "down" ||
                      region.status === "killed" ||
                      region.disabled;

                    return (
                      <div
                        key={region.id}
                        className="flex flex-col justify-between rounded-xl border border-slate-700 bg-slate-950/70 p-4 shadow-sm shadow-slate-950/60"
                      >
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <p className="text-sm font-semibold text-slate-50">
                                {region.display_name}
                              </p>
                              <p className="text-[11px] uppercase tracking-wide text-slate-400">
                                {region.slug}
                              </p>
                            </div>
                            {renderRegionStatus(region.status)}
                          </div>
                          <div className="space-y-1 text-xs text-slate-400">
                            <p className="font-mono">
                              IP: {region.ip || "pending"}
                            </p>
                            <p>
                              Latency:{" "}
                              {typeof region.latency_ms === "number"
                                ? `${region.latency_ms} ms`
                                : "—"}
                            </p>
                          </div>
                        </div>
                        <div className="mt-4 flex items-center justify-between">
                          <span className="text-[11px] text-slate-500">
                            ID:{" "}
                            <span className="font-mono">{region.id}</span>
                          </span>
                          <button
                            onClick={() => handleKill(region)}
                            disabled={killDisabled}
                            className={`inline-flex items-center justify-center rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                              killDisabled
                                ? "cursor-not-allowed border-slate-700 bg-slate-900 text-slate-500"
                                : "border-red-500 bg-red-600/90 text-white hover:bg-red-500"
                            }`}
                          >
                            Kill
                          </button>
                        </div>
                      </div>
                    );
                  })}
            </div>
          </div>

          {/* Right column: result + logs */}
          <div className="flex flex-col gap-4">
            {/* Result */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-lg shadow-slate-950/60">
              <h2 className="mb-3 text-sm font-semibold text-slate-100">
                Generation result
              </h2>
              {lastResult ? (
                <div className="space-y-3">
                  {lastResult.image_url && (
                    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/70">
                      <img
                        src={lastResult.image_url}
                        alt="Generated"
                        className="h-56 w-full object-cover"
                      />
                    </div>
                  )}
                  {lastResult.error && (
                    <p className="text-xs text-red-400">
                      Error: {lastResult.error}
                    </p>
                  )}
                  {!lastResult.image_url && !lastResult.error && (
                    <p className="text-xs text-slate-400">
                      Model responded but did not return an image url.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-400">
                  Run a generation to see the result here. If all regions are
                  down, the failure will show up instead.
                </p>
              )}
            </div>

            {/* Logs */}
            <div className="flex-1 rounded-2xl border border-slate-800 bg-slate-950/80 p-4 shadow-lg shadow-slate-950/60">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-100">
                  Event log
                </h2>
                <button
                  onClick={() => setLogs([])}
                  className="text-[11px] text-slate-500 hover:text-slate-300"
                >
                  Clear
                </button>
              </div>
              <div className="h-52 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/80 p-2 text-xs font-mono text-slate-200">
                {logs.length === 0 ? (
                  <p className="text-[11px] text-slate-500">
                    Actions will appear here, including deployments, kill
                    events, inference calls, and errors.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {logs.map((log) => (
                      <li key={log.id} className="whitespace-pre-wrap">
                        <span className="text-sky-400">[{log.time}]</span>{" "}
                        <span>{log.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </section>

        {error && (
          <div className="mt-4 rounded-xl border border-red-700 bg-red-900/40 px-4 py-2 text-xs text-red-100">
            {error}
          </div>
        )}
      </div>
    </main>
  );
}
