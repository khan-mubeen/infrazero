export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:9000";

export async function fetchRegions() {
  const res = await fetch(`${API_BASE}/regions`, { cache: "no-store" });
  return res.json();
}

export async function deployGlobal() {
  const res = await fetch(`${API_BASE}/deploy/global`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return res.json();
}

export async function infer(prompt: string) {
  const res = await fetch(`${API_BASE}/infer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  return res.json();
}

export async function killRegion(id: string) {
  const res = await fetch(`${API_BASE}/kill/${id}`, {
    method: "POST",
  });
  return res.json();
}
