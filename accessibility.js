(function () {
  const storageKey = "horizon-accessibility";
  const defaults = {
    ultraContrast: false,
    textScale: 100,
    imageScale: 100
  };

  const state = {
    settings: null,
    ui: null
  };

  const speechSupported = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) {
        return { ...defaults };
      }

      const parsed = JSON.parse(raw);
      return {
        ultraContrast: Boolean(parsed.ultraContrast),
        textScale: clamp(Number(parsed.textScale) || defaults.textScale, 90, 160),
        imageScale: clamp(Number(parsed.imageScale) || defaults.imageScale, 100, 180)
      };
    } catch {
      return { ...defaults };
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  }

  function setButtonState(button, pressed) {
    button.setAttribute("aria-pressed", pressed ? "true" : "false");
  }

  function setStatus(message) {
    if (!state.ui || !state.ui.statusText) {
      return;
    }

    state.ui.statusText.textContent = message;
  }

  function applySettings() {
    const settings = state.settings;
    document.documentElement.setAttribute("data-contrast", settings.ultraContrast ? "ultra" : "normal");
    document.documentElement.style.fontSize = settings.textScale + "%";
    document.documentElement.style.setProperty("--user-image-scale", String(settings.imageScale / 100));
    document.body.classList.toggle("a11y-image-scale", settings.imageScale > 100);

    if (state.ui) {
      state.ui.textSizeInput.value = String(settings.textScale);
      state.ui.imageSizeInput.value = String(settings.imageScale);
      state.ui.textSizeValue.textContent = settings.textScale + "%";
      state.ui.imageSizeValue.textContent = settings.imageScale + "%";
      state.ui.contrastButton.textContent = settings.ultraContrast ? "On" : "Off";
      setButtonState(state.ui.contrastButton, settings.ultraContrast);
    }

    saveSettings(settings);
  }

  function getReadableText() {
    const main = document.querySelector("main");
    const source = main || document.body;
    return (source.innerText || "").replace(/\s+/g, " ").trim();
  }

  function speakText(text) {
    if (!speechSupported) {
      setStatus("Text-to-speech is not supported in this browser.");
      return;
    }

    const normalized = (text || "").trim();
    if (!normalized) {
      setStatus("No readable text found.");
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(normalized.slice(0, 12000));
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = function () {
      setStatus("Reading complete.");
    };
    utterance.onerror = function () {
      setStatus("Unable to read text right now.");
    };

    setStatus("Reading started.");
    window.speechSynthesis.speak(utterance);
  }

  function createAccessibilitySection(panel) {
    const existing = panel.querySelector("#side-menu-accessibility");
    if (existing) {
      existing.remove();
    }

    const host = panel.querySelector(".side-menu-footer") || panel;
    const section = document.createElement("details");
    section.className = "side-menu-accessibility";
    section.id = "side-menu-accessibility";

    section.innerHTML = [
      '<summary class="side-menu-accessibility-summary">Accessibility</summary>',
      '<div class="side-menu-accessibility-body">',
      '  <div class="a11y-control-row">',
      '    <span>Ultra contrast</span>',
      '    <button type="button" class="btn btn-submit btn-mini a11y-toggle" data-a11y-toggle="contrast">Off</button>',
      '  </div>',
      '  <label class="a11y-label" for="a11y-text-size">Text size</label>',
      '  <input id="a11y-text-size" class="a11y-range" type="range" min="90" max="160" step="5" />',
      '  <p id="a11y-text-size-value" class="a11y-value"></p>',
      '  <label class="a11y-label" for="a11y-image-size">Image magnifier</label>',
      '  <input id="a11y-image-size" class="a11y-range" type="range" min="100" max="180" step="10" />',
      '  <p id="a11y-image-size-value" class="a11y-value"></p>',
      '  <div class="a11y-tts-wrap">',
      '    <h5>TTS tools</h5>',
      '    <div class="a11y-tts-grid">',
      '      <button type="button" class="btn btn-submit btn-mini" data-a11y-tts="page">Read page</button>',
      '      <button type="button" class="btn btn-submit btn-mini" data-a11y-tts="selection">Read selection</button>',
      '      <button type="button" class="btn btn-submit btn-mini" data-a11y-tts="pause">Pause/Resume</button>',
      '      <button type="button" class="btn btn-submit btn-mini" data-a11y-tts="stop">Stop</button>',
      '    </div>',
      '  </div>',
      '  <p class="a11y-shortcuts">',
      '    <span class="a11y-shortcut-item"><strong>Open</strong> Alt+Shift+A</span>',
      '    <span class="a11y-shortcut-item"><strong>Read</strong> Alt+Shift+R</span>',
      '    <span class="a11y-shortcut-item"><strong>Stop</strong> Alt+Shift+S</span>',
      '  </p>',
      '  <button type="button" class="btn btn-submit btn-mini" data-a11y-action="reset">Reset accessibility</button>',
      '  <p class="a11y-status" aria-live="polite"></p>',
      '</div>'
    ].join("");

    host.insertBefore(section, host.firstChild);

    state.ui = {
      section,
      contrastButton: section.querySelector("[data-a11y-toggle='contrast']"),
      textSizeInput: section.querySelector("#a11y-text-size"),
      imageSizeInput: section.querySelector("#a11y-image-size"),
      textSizeValue: section.querySelector("#a11y-text-size-value"),
      imageSizeValue: section.querySelector("#a11y-image-size-value"),
      statusText: section.querySelector(".a11y-status")
    };

    state.ui.contrastButton.addEventListener("click", function () {
      state.settings.ultraContrast = !state.settings.ultraContrast;
      applySettings();
      setStatus(state.settings.ultraContrast ? "Ultra contrast enabled." : "Ultra contrast disabled.");
    });

    state.ui.textSizeInput.addEventListener("input", function () {
      state.settings.textScale = clamp(Number(state.ui.textSizeInput.value), 90, 160);
      applySettings();
    });

    state.ui.imageSizeInput.addEventListener("input", function () {
      state.settings.imageScale = clamp(Number(state.ui.imageSizeInput.value), 100, 180);
      applySettings();
    });

    section.addEventListener("click", function (event) {
      const ttsButton = event.target.closest("[data-a11y-tts]");
      if (ttsButton) {
        const action = ttsButton.getAttribute("data-a11y-tts");

        if (action === "page") {
          speakText(getReadableText());
        } else if (action === "selection") {
          const selection = window.getSelection ? String(window.getSelection()) : "";
          speakText(selection);
        } else if (action === "pause") {
          if (!speechSupported) {
            setStatus("Text-to-speech is not supported in this browser.");
          } else if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
            window.speechSynthesis.pause();
            setStatus("Reading paused.");
          } else if (window.speechSynthesis.paused) {
            window.speechSynthesis.resume();
            setStatus("Reading resumed.");
          }
        } else if (action === "stop") {
          if (!speechSupported) {
            setStatus("Text-to-speech is not supported in this browser.");
          } else {
            window.speechSynthesis.cancel();
            setStatus("Reading stopped.");
          }
        }

        return;
      }

      const actionButton = event.target.closest("[data-a11y-action]");
      if (!actionButton) {
        return;
      }

      const action = actionButton.getAttribute("data-a11y-action");
      if (action !== "reset") {
        return;
      }

      state.settings = { ...defaults };
      applySettings();

      if (speechSupported) {
        window.speechSynthesis.cancel();
      }

      setStatus("Accessibility settings reset.");
    });

    applySettings();
  }

  function initAccessibilityMenu() {
    const panel = document.querySelector(".side-menu-panel");
    if (!panel) {
      return;
    }

    createAccessibilitySection(panel);
  }

  function ensureMenuOpen() {
    const panel = document.querySelector(".side-menu-panel");
    if (!panel) {
      return false;
    }

    if (panel.classList.contains("is-open")) {
      return true;
    }

    const toggleButton = document.querySelector(".menu-toggle-btn");
    if (!toggleButton) {
      return false;
    }

    toggleButton.click();
    return true;
  }

  function openAccessibilityInMenu() {
    const opened = ensureMenuOpen();
    if (!opened) {
      setStatus("Menu is unavailable on this page.");
      return;
    }

    const section = document.querySelector("#side-menu-accessibility");
    if (!section) {
      setStatus("Accessibility section is unavailable right now.");
      return;
    }

    section.open = true;
    const summary = section.querySelector(".side-menu-accessibility-summary");
    if (summary) {
      summary.focus();
    }

    setStatus("Accessibility section opened.");
  }

  function addKeyboardShortcuts() {
    document.addEventListener("keydown", function (event) {
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) {
        return;
      }

      const target = event.target;
      const isTypingField = target && (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      );

      if (isTypingField) {
        return;
      }

      const key = String(event.key || "").toLowerCase();

      if (key === "a") {
        event.preventDefault();
        openAccessibilityInMenu();
        return;
      }

      if (key === "r") {
        event.preventDefault();
        speakText(getReadableText());
        return;
      }

      if (key === "s") {
        if (!speechSupported) {
          return;
        }

        event.preventDefault();
        window.speechSynthesis.cancel();
        setStatus("Reading stopped.");
      }
    });
  }

  function bootstrap() {
    state.settings = loadSettings();
    applySettings();
    initAccessibilityMenu();
    addKeyboardShortcuts();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();