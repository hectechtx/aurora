import { QueryClient, QueryFunction } from "@tanstack/react-query";

const TOKEN_KEY = "aurora-token";
let token: string | null = typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;

export function getToken(): string | null {
  return token;
}

export function setToken(next: string | null): void {
  token = next;
  if (next) localStorage.setItem(TOKEN_KEY, next);
  else localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    if (res.status === 401) {
      // Session is gone (expired/server restarted) — drop the stale token
      // and reload so AuthGate re-checks status and shows the PIN screen.
      setToken(null);
      window.location.reload();
    }
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(method: string, url: string, data?: unknown): Promise<Response> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (data) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: data ? JSON.stringify(data) : undefined });
  await throwIfResNotOk(res);
  return res;
}

export const getQueryFn: <T>() => QueryFunction<T> = () => async ({ queryKey }) => {
  const res = await fetch(queryKey.join("/"), { headers: authHeaders() });
  await throwIfResNotOk(res);
  return res.json();
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn(),
      refetchOnWindowFocus: false,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
