// Stamps the stored style and color mode on <html> before first paint, so a
// light-mode user never sees a dark flash. Mirrors app/hooks/useTheme.ts and
// app/hooks/useColorMode.ts (same keys, same fallbacks) - keep them in step.
// A file, not an inline script: the app's CSP is script-src 'self'.
(function () {
  try {
    var root = document.documentElement;
    var theme = localStorage.getItem("mineui-theme");
    if (["deepslate", "phosphor", "quantum", "softglass"].indexOf(theme) < 0) theme = "deepslate";
    root.dataset.theme = theme;
    var pref = localStorage.getItem("mineui-color-mode");
    var light =
      pref === "light" ||
      (pref === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
    root.dataset.mode = light ? "light" : "dark";
  } catch {
    /* storage unavailable: the CSS defaults (deepslate, dark) apply */
  }
})();
