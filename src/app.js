
"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const menuToggle = document.getElementById("menu-toggle");
  const mainNav = document.querySelector(".main-nav");

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

    mainNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        mainNav.classList.remove("open");
        menuToggle.setAttribute("aria-expanded", "false");
        menuToggle.setAttribute("aria-label", "Toggle navigation");
        menuToggle.textContent = "☰";
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        mainNav.classList.remove("open");
        menuToggle.setAttribute("aria-expanded", "false");
        menuToggle.setAttribute("aria-label", "Toggle navigation");
        menuToggle.textContent = "☰";
      }
    });
  }

  // Connect the three main buttons to the career exploration section
  const startButtons = [
    document.getElementById("start-button"),
    document.getElementById("hero-start"),
    document.getElementById("closing-start")
  ];

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

  // Automatically update the copyright year
  const copyright = document.querySelector(".site-footer > span");

  if (copyright) {
    copyright.textContent = `© ${new Date().getFullYear()} YourPath`;
  }
});
