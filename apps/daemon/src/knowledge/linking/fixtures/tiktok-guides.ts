/**
 * Two entries shaped like a live pair the pair checks judged on cut text (2026-10-27): a short
 * 13-step guide that says "make an outlook/proton email", and a long guide (about 15,000
 * characters) whose "use Gmail, other providers carry a higher risk" passage sits far past its
 * opening. Wording is shortened and rephrased from the saved entries; the shape (numbered steps,
 * one paragraph per line, the key passage deep inside) is theirs.
 */

import type { KnowledgeConceptRef } from "@orquester/api";

export const SHORT_GUIDE = {
  id: "ke_bk4lk3nknmiw",
  title: "Make any phone hit a US audience on TikTok: 13 steps (used iPhone, ISP proxy, Shadowrocket)",
  body: [
    "heres how to make any phone hit a US audience on tiktok. step by step",
    "1) buy a used iphone 12 (~$50), factory reset it and take the sim out",
    "2) on the setup screens set the language to english and the country to United States, then connect to wifi",
    "3) create a US apple id and verify it with a US number from grizzly sms",
    "4) turn off mobile data and bluetooth, then Location Services off and Find My iPhone off",
    '5) Settings → General → Date & Time → disable "Set Automatically" → set to the US city your proxy is in',
    "6) open the weather app, it should now show US weather",
    "7) download shadowrocket from the app store (you need a US itunes gift card since the account is US)",
    '8) buy an isp proxy at iproyal, pick the "ip quality" option for a low fraud score, then set the protocol to socks5',
    "9) add it in shadowrocket: set the type to socks5, then enter the address, port, user and password and save",
    "10) check the proxy at ipqualityscore.com and scamalytics.com, both have to read low risk",
    "11) make an outlook/proton email and use it to create the tiktok account",
    "12) open the app, if you see a US shop and a US for you page its all set up right",
    "13) then warm it up for 48 hours before you post, just scroll a few times a day and engage with US content"
  ].join("\n\n")
};

export const SHORT_GUIDE_CONCEPTS: KnowledgeConceptRef[] = [
  { id: "tactic-outlook-proton-email", type: "Tactic", name: "Outlook/Proton email for TikTok account" },
  { id: "tool-shadowrocket", type: "Tool", name: "Shadowrocket" },
  { id: "tactic-isp-proxy-socks5", type: "Tactic", name: "ISP proxy with socks5" },
  { id: "tactic-48h-warm-up", type: "Tactic", name: "Warm up the account for 48 hours before posting" }
];

/** The sentence the check must see in {@link LONG_GUIDE}. */
export const GMAIL_PASSAGE =
  "Use Gmail specifically, other email providers (Outlook, Yahoo, ProtonMail, etc.) carry a significantly higher risk of your TikTok account getting flagged or banned. Gmail is the safest and most widely accepted option.";

function filler(topic: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(
      `${topic}, part ${i + 1}: take your time here and write down what you changed. Every device in the farm should go through the same routine, in the same order, so a mistake on one phone is easy to trace back later and does not spread to the others you manage.`
    );
  }
  return out;
}

export const LONG_GUIDE = {
  id: "ke_mq74jvvzggnn",
  title: "Step-by-step iPhone setup for TikTok to target US (or any country) users + account warm-up",
  body: [
    "Step-by-step phone setup for TikTok to target US (or any country) users and proper account warm-up.",
    "This is why I target US users instead of local users: users in my country have an extremely low payment conversion rate from apps, while the US and other developed countries have a much higher rate. This playbook is free and not sponsored by anyone.",
    "Step 1: Factory Reset the iPhone",
    "Before setting up any iPhone for use in a TikTok farm, you need to ensure the device is in a completely clean state. A factory reset wipes all previous data, accounts, settings and cached location info.",
    ...filler("Resetting", 8),
    "Step 2: Set Language and Region",
    "On the Hello screen, select the language of your target country and the matching region. These settings must align with your VPN/proxy IP, SIM card, and the time zone you will set in later steps.",
    ...filler("Region settings", 8),
    "Step 3: Create a New iCloud Account",
    "First, create a fresh email",
    "Go to mail.google.com and create a brand new Gmail account.",
    GMAIL_PASSAGE,
    "Don't reuse any personal information from your real accounts. Use a fresh name.",
    "Then create the Apple ID with the fresh Gmail you just created as the Apple ID email.",
    ...filler("Apple ID", 6),
    "Step 4: Set App Store Region to Target Country",
    "The App Store region is a separate setting tied to your Apple ID. Make sure it matches your target country so you download the correct regional version of TikTok.",
    ...filler("App Store region", 6),
    "Step 5: Install and Configure VPN/Proxy",
    "Use a paid service with a dedicated/static IP. Free VPNs use shared IP pools that get flagged and blacklisted fast.",
    ...filler("Proxy setup", 8),
    "Step 6: Create TikTok Accounts",
    "Sign up using the same fresh Gmail you created in Step 3 for your first account. Start with just 1–2 accounts.",
    ...filler("Account creation", 6),
    "Final Notes",
    "Keep your VPN active at all times. Never open TikTok without your VPN or proxy connected.",
    ...filler("Daily routine", 6)
  ].join("\n")
};

export const LONG_GUIDE_CONCEPTS: KnowledgeConceptRef[] = [
  { id: "tactic-fresh-gmail", type: "Tactic", name: "Create TikTok accounts with a fresh Gmail" },
  { id: "tactic-static-ip", type: "Tactic", name: "Install and configure a paid dedicated/static IP VPN/proxy" },
  { id: "tactic-48h-warm-up", type: "Tactic", name: "Warm up the account for 48 hours before posting" }
];
