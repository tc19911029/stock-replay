"use client";
import { useEffect } from "react";

export default function RegisterPWA() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Registration failed — likely in dev mode without sw.js
      });
    }
  }, []);
  return null;
}
