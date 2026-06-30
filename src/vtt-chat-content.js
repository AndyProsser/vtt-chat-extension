// Relay content script for the VTT-Chat server origin(s).
//
// The /ext-launch page signals DM-link completion by posting a message to its
// own window (window.postMessage). A content script can receive that — even in
// Chrome, where the content script runs in an isolated JS realm — because
// window message events cross into that realm. (BroadcastChannel does NOT, which
// is why postMessage is used.) We relay the message to the service worker, which
// stores the credential and launches the session.
//
// This script is registered dynamically by background.js for each configured
// server origin (see syncVttChatContentScripts) rather than via a static
// manifest entry, because the server URL is user-configured, not known at build.

// Polyfill for Chrome/Edge
if (typeof browser === "undefined") {
  var browser = chrome;
}

let dmLinkHandled = false;

window.addEventListener("message", (event) => {
  // Only accept messages the page posted to itself on this same origin —
  // never relay anything coming from an embedded iframe or another origin.
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== "VTT_CHAT_DM_LINK_COMPLETE") return;
  if (dmLinkHandled) return;
  dmLinkHandled = true;

  browser.runtime.sendMessage(event.data).catch(() => {
    // Service worker may be asleep or the message channel closed — the
    // background also watches for the URL-hash signal as a fallback.
  });
});
