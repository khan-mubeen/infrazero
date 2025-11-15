"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import Image from "next/image";
import { deployGlobal, fetchRegions, infer, killRegion } from "../lib/api";

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

type LastResult = {
  prompt?: string;
  image_url?: string;
  region_id?: string;
  region_slug?: string;
  region_name?: string;
  latency_ms?: number;
  error?: string;
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
  "northern lights in the sky",
  "tropical island paradise",
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

  const [refreshInterval, setRefreshInterval] = useState<number>(15000);
  const lastRefreshTimeRef = useRef<number>(0);

  const appendLog = useCallback((message: string) => {
    const now = new Date();
    setLogs((prev) => [
      {
        id: `${now.getTime()}-${Math.random().toString(16).slice(2)}`,
        timestamp: formatTime(now),
        message,
      },
      ...prev.slice(0, 50), // Keep only last 50 logs
    ]);
  }, []);

  // Fix: Improved loadRegions with proper throttling
  const loadRegions = useCallback(async (force: boolean = false) => {
    // Do not start another load if one is already in progress (unless forced)
    if (isLoadingRegions && !force) return;

    const now = Date.now();
    const last = lastRefreshTimeRef.current;

    // Prevent too frequent refreshes (min 2 seconds between auto-refreshes)
    if (!force && now - last < 2000) {
      return;
    }

    setIsLoadingRegions(true);
    try {
      const data = (await fetchRegions()) as RegionsResponse;
      if (data.deployment_id) {
        setDeploymentId(data.deployment_id);
      }

      if (Array.isArray(data.regions)) {
        setRegions(currentRegions => {
          return data.regions.map(newRegion => {
            const currentRegion = currentRegions.find(r => r.id === newRegion.id);
            if (currentRegion && (currentRegion.status === "killed" || currentRegion.status === "down")) {
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
      appendLog(`❌ Failed to load regions: ${msg}`);
    } finally {
      setIsLoadingRegions(false);
    }
  }, [appendLog, isLoadingRegions]);

  // Fix: Improved useEffect with better refresh control
  useEffect(() => {
    loadRegions(true); // Initial load
    
    if (refreshInterval <= 0) return; // Manual refresh mode
    
    const interval = setInterval(() => {
      loadRegions();
    }, refreshInterval);
    
    return () => clearInterval(interval);
  }, [loadRegions, refreshInterval]);

  const hasHealthyRegion = useMemo(
    () => regions.some((r) => r.status === "healthy" && !r.disabled),
    [regions]
  );

  const healthyCount = useMemo(
    () => regions.filter((r) => r.status === "healthy").length,
    [regions]
  );

  // Fix: Count killed regions properly
  const killedCount = useMemo(
    () => regions.filter((r) => r.status === "killed" || r.status === "down").length,
    [regions]
  );

  const handleDeploy = useCallback(async () => {
    if (isDeploying) return;
    
    setIsDeploying(true);
    setError(null);
    appendLog("🚀 Deploying global infrastructure...");

    try {
      const data = await deployGlobal();
      const newDeploymentId = data?.deployment_id || (MODE === "mock" ? "mock-deployment" : null);

      if (newDeploymentId) {
        setDeploymentId(newDeploymentId);
        appendLog(`✅ Deployment started: ${newDeploymentId}`);
      }

      if (data && Array.isArray(data.regions)) {
        setRegions(data.regions);
        appendLog(`✅ Deployed ${data.regions.length} regions`);
      } else {
        await loadRegions(true);
      }
    } catch (e) {
      const msg = (e as Error).message || "Unknown error";
      setError("Deployment failed");
      appendLog(`❌ Deploy failed: ${msg}`);
    } finally {
      setIsDeploying(false);
    }
  }, [appendLog, isDeploying, loadRegions]);

  // Fix: Improved kill region logic
  const handleKill = useCallback(
    async (region: Region) => {
      if (isKillDisabled(region) || killingRegion) return;
      
      setKillingRegion(region.id);
      appendLog(`💀 Killing region: ${region.display_name}`);
      setError(null);

      try {
        await killRegion(region.id);
        
        // Fix: Immediately update UI to show killed status
        setRegions(currentRegions => 
          currentRegions.map(r => 
            r.id === region.id 
              ? { ...r, status: "killed", latency_ms: null }
              : r
          )
        );
        
        appendLog(`✅ Region killed: ${region.display_name}`);
        
        // Small delay before refreshing to show the killed state
        setTimeout(() => {
          loadRegions(true);
        }, 1000);
        
      } catch (e) {
        const msg = (e as Error).message || "Unknown error";
        setError(`Failed to kill region`);
        appendLog(`❌ Kill failed: ${msg}`);
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

    const trimmedPrompt = prompt.trim();
    appendLog(`🎨 Generating: "${trimmedPrompt}"`);

    try {
      const data = (await infer(trimmedPrompt)) as LastResult;
      const finalResult: LastResult = {
        ...data,
        prompt: trimmedPrompt,
      };

      setLastResult(finalResult);

      if (data.error) {
        appendLog(`❌ Generation error: ${data.error}`);
      } else {
        const regionLabel = data.region_name || data.region_slug || "unknown";
        const latency = data.latency_ms || 0;
        appendLog(`✅ Generated from ${regionLabel} (${latency}ms)`);
      }
    } catch (e) {
      const msg = (e as Error).message || "Unknown error";
      setLastResult({
        prompt: trimmedPrompt,
        error: "Service unavailable",
      });
      setError("Generation failed");
      appendLog(`❌ Generation failed: ${msg}`);
    } finally {
      setIsGenerating(false);
    }
  }, [appendLog, isGenerating, prompt]);

  const handleExamplePrompt = useCallback((examplePrompt: string) => {
    setPrompt(examplePrompt);
  }, []);

  // Fix: Manual refresh handler
  const handleManualRefresh = useCallback(() => {
    loadRegions(true);
  }, [loadRegions]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-50">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        {/* Header */}
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
                Deployment: <span className="font-mono text-sky-300">{deploymentId}</span>
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
              MODE === "mock"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                : "bg-purple-500/20 text-purple-300 border border-purple-500/30"
            }`}>
              <span className="mr-1.5 h-2 w-2 rounded-full bg-current" />
              {MODE === "mock" ? "Local Demo" : "Vultr Live"}
            </span>
            {error && (
              <span className="max-w-xs rounded-lg bg-red-500/10 border border-red-500/30 px-2 py-1 text-xs text-red-300">
                ⚠️ {error}
              </span>
            )}
          </div>
        </header>

        {/* Stats */}
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

        {/* Controls */}
        <section className="mb-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <h2 className="mb-3 text-base font-semibold text-slate-100">🎛️ Orchestration</h2>
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
                {isDeploying ? "🚀 Deploying..." : "🚀 Deploy Global"}
              </button>
              <button
                onClick={handleManualRefresh}
                disabled={isLoadingRegions}
                className="rounded-xl border border-slate-600 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-100 hover:bg-slate-700/80"
              >
                {isLoadingRegions ? "Refreshing..." : "🔄 Refresh"}
              </button>
              
              {/* Fix: Refresh rate control */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-400">Refresh:</label>
                <select 
                  value={refreshInterval}
                  onChange={(e) => setRefreshInterval(Number(e.target.value))}
                  className="rounded-lg border border-slate-600 bg-slate-800/60 px-2 py-1 text-xs text-slate-100"
                >
                  <option value="0">Manual</option>
                  <option value="5000">5s</option>
                  <option value="8000">8s</option>
                  <option value="15000">15s</option>
                </select>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <h2 className="mb-3 text-base font-semibold text-slate-100">🎨 Image Generation</h2>
            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-xs text-slate-300">Prompt</label>
                <textarea
                  rows={2}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                  placeholder="Describe what you want to generate..."
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {EXAMPLE_PROMPTS.slice(0, 3).map((example, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleExamplePrompt(example)}
                      className="rounded-lg border border-slate-700 bg-slate-800/50 px-2 py-1 text-[10px] text-slate-400 hover:bg-slate-700/50"
                    >
                      {example}
                    </button>
                  ))}
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
                  {isGenerating ? "⏳ Generating..." : "✨ Generate"}
                </button>
                <div className="text-xs text-slate-400">
                  {healthyCount > 0 ? (
                    <span className="text-emerald-400">✓ {healthyCount} ready</span>
                  ) : (
                    <span className="text-red-400">⚠️ No regions</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Main Content */}
        <section className="grid flex-1 gap-6 lg:grid-cols-[1.5fr,1fr]">
          {/* Regions */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-100">🌍 Regions</h2>
              <span className="text-xs text-slate-500">
                {healthyCount} healthy, {killedCount} killed
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {regions.map((region) => (
                <div key={region.id} className={`rounded-xl border ${
                  region.status === "killed" || region.status === "down"
                    ? "border-red-500/50 bg-red-900/20"
                    : "border-slate-700/50 bg-slate-900/90"
                } p-4`}>
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-slate-50">{region.display_name}</p>
                        <p className="text-xs font-mono uppercase text-slate-400">{region.slug}</p>
                      </div>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        region.status === "healthy" ? "bg-emerald-400/20 text-emerald-300 border border-emerald-400/30" :
                        region.status === "starting" ? "bg-amber-400/20 text-amber-300 border border-amber-400/30" :
                        "bg-red-400/20 text-red-300 border border-red-400/30"
                      }`}>
                        <span className="mr-1 h-1.5 w-1.5 rounded-full bg-current" />
                        {region.status}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400">
                      <p>Latency: <span className="font-mono text-sky-300">
                        {region.status === "killed" || region.status === "down" 
                          ? "—" 
                          : typeof region.latency_ms === "number" 
                            ? `${region.latency_ms}ms` 
                            : "—"
                        }
                      </span></p>
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
                      {killingRegion === region.id ? "💀 Killing..." : 
                       region.status === "killed" || region.status === "down" ? "💀 Killed" : "💀 Kill Region"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right Column */}
          <div className="flex flex-col gap-4">
            {/* Result */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
              <h2 className="mb-3 text-base font-semibold text-slate-100">🖼️ Result</h2>
              {lastResult ? (
                <div className="space-y-3">
                  {/* Show region and latency FIRST, before the image */}
                  {!lastResult.error && (
                    <div className="text-xs text-slate-400 space-y-1">
                      <p>Region: <span className="font-semibold text-sky-300">
                        {lastResult.region_name || lastResult.region_slug}
                      </span></p>
                      {lastResult.latency_ms && (
                        <p>Latency: <span className="font-mono text-emerald-300">{lastResult.latency_ms}ms</span></p>
                      )}
                    </div>
                  )}
                  
                  {/* Then show the image */}
                  {lastResult.image_url && (
                    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
                      <Image
                        src={lastResult.image_url}
                        alt="Generated"
                        width={512}
                        height={512}
                        className="w-full object-cover"
                        unoptimized
                      />
                    </div>
                  )}
                  
                  {/* Error message stays at the bottom */}
                  {lastResult.error && (
                    <p className="rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-300">
                      {lastResult.error}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-400">Generate an image to see results</p>
              )}
            </div>

            {/* Logs */}
            <div className="flex-1 rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-100">📋 Event Log</h2>
                <button onClick={() => setLogs([])} className="text-xs text-slate-500 hover:text-slate-300">
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
                        <span className="text-slate-500">[{log.timestamp}]</span> {log.message}
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