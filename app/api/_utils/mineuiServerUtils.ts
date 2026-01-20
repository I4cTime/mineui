import { serverConfig } from "@/app/lib/serverConfig";

const trimSlash = (value: string) => value.replace(/\/+$/, "");

export const getServerUtilsBaseUrl = () => {
  const url = serverConfig.mineuiServerUtilsUrl?.trim();
  return url ? trimSlash(url) : "";
};

export const fetchServerUtilsJson = async <T,>(path: string): Promise<T> => {
  const baseUrl = getServerUtilsBaseUrl();
  if (!baseUrl) {
    throw new Error("MINEUI_SERVER_UTILS_URL not configured");
  }
  const res = await fetch(`${baseUrl}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Server utils request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
};
