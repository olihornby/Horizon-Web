(function () {
  const tokenKey = "horizonUserToken";
  const userKey = "horizonUserProfile";

  function getToken() {
    return localStorage.getItem(tokenKey) || "";
  }

  function getUser() {
    const raw = localStorage.getItem(userKey);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function setSession(token, user) {
    if (token) {
      localStorage.setItem(tokenKey, token);
    }

    if (user) {
      localStorage.setItem(userKey, JSON.stringify(user));
    }
  }

  function clearSession() {
    localStorage.removeItem(tokenKey);
    localStorage.removeItem(userKey);
  }

  async function authFetch(url, options) {
    const token = getToken();
    const settings = options ? { ...options } : {};
    settings.headers = {
      ...(settings.headers || {}),
      ...(token ? { Authorization: "Bearer " + token } : {})
    };

    return fetch(url, settings);
  }

  async function fetchJson(url, options) {
    const response = await authFetch(url, options);
    const payload = await response.json().catch(function () {
      return { ok: false, message: "Unexpected response" };
    });

    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || "Request failed");
    }

    return payload;
  }

  window.HorizonAuth = {
    getToken,
    getUser,
    setSession,
    clearSession,
    authFetch,
    fetchJson
  };
})();
