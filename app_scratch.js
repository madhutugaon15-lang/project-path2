/* =========================================
   YOURPATH — APPLICATION JAVASCRIPT
   ========================================= */

"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const menuToggle = document.getElementById("menu-toggle");
  const mainNav = document.querySelector(".main-nav");

  const startButtons = [
    document.getElementById("start-button"),
    document.getElementById("hero-start"),
    document.getElementById("closing-start")
  ];

  // Mobile navigation
  if (menuToggle && mainNav) {
    menuToggle.addEventListener("click", () => {
      const isOpen = mainNav.classList.toggle("open");

      menuToggle.setAttribute("aria-expanded", String(isOpen));
      menuToggle.setAttribute(
        "aria-label",
        isOpen ? "Close navigation" : "Toggle navigation"
      );

      menuToggle.textContent = isOpen ? "✕" : "☰";
    });

    // Close the menu after selecting a navigation link
    mainNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        mainNav.classList.remove("open");
        menuToggle.setAttribute("aria-expanded", "false");
        menuToggle.setAttribute("aria-label", "Toggle navigation");
        menuToggle.textContent = "☰";
      });
    });

    // Close the menu when the user presses Escape
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        mainNav.classList.remove("open");
        menuToggle.setAttribute("aria-expanded", "false");
        menuToggle.setAttribute("aria-label", "Toggle navigation");
        menuToggle.textContent = "☰";
      }
    });
  }

  // Start buttons currently take visitors to the career exploration section.
  // The interactive questionnaire will be connected in a later development step.
  startButtons.forEach((button) => {
    if (!button) return;

    button.addEventListener("click", () => {
      const exploreSection = document.getElementById("explore");

      if (exploreSection) {
        exploreSection.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      }
    });
  });

  // Update the copyright year automatically
  const copyright = document.querySelector(".site-footer > span");

  if (copyright) {
    copyright.textContent = `© ${new Date().getFullYear()} YourPath`;
  }
});