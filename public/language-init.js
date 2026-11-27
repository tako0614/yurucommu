// Mirror detectLanguage in src/atoms/i18n.ts before the app bundle runs.
(() => {
  try {
    let language = localStorage.getItem("language");
    if (language !== "ja" && language !== "en") {
      language =
        (navigator.language || "").split("-")[0] === "ja" ? "ja" : "en";
    }
    document.documentElement.lang = language;
  } catch {
    // Keep the document default if storage is unavailable.
  }
})();
