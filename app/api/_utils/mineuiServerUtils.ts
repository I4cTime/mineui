import { getServerConfig } from "@/app/lib/serverConfig";

const trimSlash = (value: string) => value.replace(/\/+$/, "");

export const getServerUtilsBaseUrl = async () => {
  const config = await getServerConfig();
  const url = config.mineuiServerUtilsUrl?.trim();
  return url ? trimSlash(url) : "";
};

export const fetchServerUtilsJson = async <T,>(path: string): Promise<T> => {
  const baseUrl = await getServerUtilsBaseUrl();
  if (!baseUrl) {
    throw new Error("MINEUI_SERVER_UTILS_URL not configured");
  }
  const res = await fetch(`${baseUrl}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Server utils request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
};
