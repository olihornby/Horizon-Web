(function () {
  const storageKey = "horizon-theme";
  const root = document.documentElement;

  function getInitialTheme() {
    const stored = localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark") {
      return stored;
    }

    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);

    document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
      const isDark = theme === "dark";
      button.textContent = isDark ? "Light mode" : "Dark mode";
      button.setAttribute("aria-pressed", isDark ? "true" : "false");
      button.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    });
  }

  function toggleTheme() {
    const current = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(storageKey, next);
    applyTheme(next);
  }

  document.addEventListener("click", function (event) {
    const toggle = event.target.closest("[data-theme-toggle]");
    if (!toggle) {
      return;
    }

    toggleTheme();
  });

  applyTheme(getInitialTheme());
})();