(function () {
  function createMenu() {
    const body = document.body;
    const auth = window.HorizonAuth;
    const user = auth ? auth.getUser() : null;
    const isLoggedIn = Boolean(auth && auth.getToken());
    const adminUnlocked = sessionStorage.getItem("horizonAdminMenuVisible") === "1";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-toggle-btn";
    button.setAttribute("aria-label", "Open navigation menu");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = "<span></span><span></span><span></span>";

    const overlay = document.createElement("div");
    overlay.className = "side-menu-overlay";

    const panel = document.createElement("aside");
    panel.className = "side-menu-panel";
    panel.setAttribute("aria-hidden", "true");

    const links = [
      { href: "index.html", label: "Home" },
      { href: "about.html", label: "About" },
      { href: "services.html", label: "Services" },
      { href: "contact.html", label: "Contact" },
      { href: "account.html", label: isLoggedIn ? "Project Portal" : "Login / Sign up" }
    ];

    if (adminUnlocked) {
      links.push({ href: "admin.html", label: "Admin" });
    }

    const linkMarkup = links
      .map(function (item) {
        return '<a class="side-menu-link" href="' + item.href + '">' + item.label + "</a>";
      })
      .join("");

    panel.innerHTML =
      '<div class="side-menu-head">' +
        '<h4>Horizon Menu</h4>' +
        '<button type="button" class="side-menu-close" aria-label="Close menu">×</button>' +
      "</div>" +
      '<div class="side-menu-links">' + linkMarkup + "</div>" +
      '<div class="side-menu-footer">' +
        '<details class="side-menu-settings" id="side-menu-settings">' +
          '<summary class="side-menu-settings-summary">Settings</summary>' +
          '<div class="side-menu-settings-body">' +
            (isLoggedIn && user ? '<p class="side-menu-user">Logged in as <strong>' + user.username + "</strong></p>" : '<p class="side-menu-user">Manage preferences and accessibility options.</p>') +
            (isLoggedIn ? '<button type="button" class="btn btn-submit side-menu-logout">Log out</button>' : "") +
          '</div>' +
        '</details>' +
      "</div>";

    function setOpen(isOpen) {
      panel.classList.toggle("is-open", isOpen);
      overlay.classList.toggle("is-open", isOpen);
      button.setAttribute("aria-expanded", isOpen ? "true" : "false");
      panel.setAttribute("aria-hidden", isOpen ? "false" : "true");
      body.classList.toggle("menu-open", isOpen);
    }

    button.addEventListener("click", function () {
      setOpen(!panel.classList.contains("is-open"));
    });

    overlay.addEventListener("click", function () {
      setOpen(false);
    });

    panel.addEventListener("click", function (event) {
      if (event.target.closest(".side-menu-close")) {
        setOpen(false);
        return;
      }

      if (event.target.closest(".side-menu-link")) {
        setOpen(false);
      }

      if (event.target.closest(".side-menu-logout")) {
        if (auth) {
          auth.clearSession();
        }

        setOpen(false);
        window.location.href = "index.html";
      }
    });

    body.appendChild(button);
    body.appendChild(overlay);
    body.appendChild(panel);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createMenu);
  } else {
    createMenu();
  }
})();
