"use client";

import { useEffect, useState } from "react";
import { fetchRegions, deployGlobal, infer, killRegion } from "@/lib/api";

type Region = {
  id: string;
  slug: string;
  display_name: string;
  status: string;
  latency_ms: number | null;
};

export default function Home() {
  const [regions, setRegions] = useState<Region[]>([]);
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [lastResult, setLastResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadRegions() {
    try {
      const data = await fetchRegions();
      setRegions(data.regions || []);
    } catch (e) {
      // if control-plane is down we just keep current list
      console.error("Failed to load regions", e);
    }
  }

  useEffect(() => {
    loadRegions();
    const id = setInterval(loadRegions, 3000);
    return () => clearInterval(id);
  }, []);

  async function handleDeploy() {
    setLoading(true);
    setError(null);
    try {
      await deployGlobal();
      await loadRegions();
    } catch (e) {
      setError("Failed to deploy global. Please check the control-plane.");
    } finally {
      setLoading(false);
    }
  }

  async function handleInfer() {
    if (!prompt.trim()) return;
    setLoading(true);
    setError(null);
    setLastResult(null);

    try {
      const res = await infer(prompt);

      if (res.error) {
        setError(res.error || "No healthy regions available.");
      } else {
        setLastResult(res);
      }
    } catch (e) {
      setError("Backend is unavailable. Try Deploy Global again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleKill(id: string) {
    try {
      await killRegion(id);
      await loadRegions();
    } catch (e) {
      setError("Failed to kill region.");
    }
  }

  function statusColor(status: string) {
    if (status === "healthy") return "bg-green-500";
    if (status === "down") return "bg-red-500";
    return "bg-yellow-500";
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Global AI Studio (InfraZero)</h1>
          <button
            onClick={handleDeploy}
            disabled={loading}
            className="px-4 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-sm font-semibold disabled:opacity-60"
          >
            {loading ? "Working..." : "Deploy Global"}
          </button>
        </header>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {regions.map((r) => (
            <div
              key={r.id}
              className="rounded-xl border border-slate-800 p-4 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-slate-400">
                    {r.slug.toUpperCase()}
                  </div>
                  <div className="font-semibold">{r.display_name}</div>
                </div>
                <span
                  className={`px-2 py-1 text-xs rounded-full ${statusColor(
                    r.status
                  )}`}
                >
                  {r.status}
                </span>
              </div>
              <div className="text-sm text-slate-300">
                Latency:{" "}
                {r.latency_ms != null ? `${Math.round(r.latency_ms)} ms` : "—"}
              </div>
              <button
                onClick={() => handleKill(r.id)}
                className="mt-auto text-xs px-3 py-1 rounded-md border border-red-500 text-red-400 hover:bg-red-500 hover:text-white disabled:opacity-60"
                disabled={r.status === "down"}
              >
                Kill region
              </button>
            </div>
          ))}
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-3">
            <h2 className="text-xl font-semibold">Generate Image</h2>
            <textarea
              className="w-full rounded-md border border-slate-700 bg-slate-900 p-2 text-sm"
              rows={4}
              placeholder="Describe your image..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <button
              onClick={handleInfer}
              disabled={loading}
              className="px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold disabled:opacity-60"
            >
              {loading ? "Generating..." : "Generate"}
            </button>
          </div>

          <div className="space-y-3">
            <h2 className="text-xl font-semibold">Result</h2>

            {error && (
              <div className="text-sm text-red-400 border border-red-500/40 bg-red-500/5 rounded-md px-3 py-2">
                {error}
              </div>
            )}

            {lastResult ? (
              <div className="space-y-2">
                <div className="text-sm text-slate-300">
                  Served by:{" "}
                  <span className="font-semibold">
                    {lastResult.region_slug}
                  </span>{" "}
                  ({lastResult.latency_ms} ms)
                </div>
                {lastResult.image_url && (
                  <img
                    src={lastResult.image_url}
                    alt="Generated"
                    className="w-full max-w-sm rounded-lg border border-slate-800"
                  />
                )}
              </div>
            ) : (
              !error && (
                <div className="text-sm text-slate-500">
                  No generation yet. Enter a prompt and click Generate.
                </div>
              )
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
