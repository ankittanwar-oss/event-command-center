// Event descriptions supplied by Marketing (webinars, demo days, workshops), keyed by HubSpot marketing-event record id
// (object 2-23538230, ids from the "Marketing event" tab of the Virtual events data sheet). Shown to SDRs as context:
// what the session covered, who spoke, and a conversation starter. Display only; never used for scoring.
export interface EventDescription { title: string; speakers: string; summary: string; hook: string }
export const EVENT_DESCRIPTIONS: Record<string, EventDescription> = {
  "60804395822": {
    "title": "The Case of the Slow Contract: An AI-Era Investigation (IHC webinar)",
    "speakers": "Pralika Jain (Hex), Alicja Kwiatkowski (Mirantis), Jonathan Perkel (Esusu); moderated by Akshay Verma (COO, SpotDraft)",
    "summary": "Where contracts really slow down (intake gaps, negotiation cycles, approvals, cross-functional dependencies) and how AI, playbooks, self-service and smarter escalation remove \"dead time\" and speed up revenue.",
    "hook": "Ask where their contracts stall today: intake, negotiation or approvals."
  },
  "61303883053": {
    "title": "Demo day with Legal Tech Hub",
    "speakers": "Product demo by Anne Hawley (SpotDraft)",
    "summary": "Live SpotDraft product demo for the Legal Tech Hub audience.",
    "hook": "They saw the product live: ask what stood out and what they would want to see on their own contracts."
  },
  "61645772391": {
    "title": "Fall Release webinar (SpotDraft-owned)",
    "speakers": "Nicole Ducharme (Astronomer), Irfan Siddiqui (BeatStars), Akshay Verma (COO, SpotDraft); demo by Marshall Deutz (Solution Engineer, SpotDraft)",
    "summary": "How AI creates leverage for whole legal teams (not just individual productivity), where human judgment stays critical, and how smaller teams scale. Marshall showcased SpotDraft's AI connecting legal workflows with existing tools.",
    "hook": "Ask whether they are still experimenting with AI or ready to use it as a force multiplier, and offer a tailored version of the release demo."
  },
  "61649672545": {
    "title": "Contract Governance Blueprint: Master Your Lifecycle (Counselwell webinar)",
    "speakers": "Ryan Mills (GC & Corporate Secretary, Chicken Farmers of Ontario), Phoebee Gahan (CLO, Nscale), Marshall Deutz (SpotDraft)",
    "summary": "Building contract governance without adding friction: inconsistent intake, unclear ownership and escalation, approval delays, post-signature obligations and renewals; risk-based processes, AI and Contracting Intelligence from intake to post-signature.",
    "hook": "Ask how they handle ownership, approvals and renewals today, and where governance slows the business down."
  },
  "62392355166": {
    "title": "Contracts That Think: The Rise of Contract Intelligence (IHC webinar)",
    "speakers": "Kiara Graves, Natasha Giuffre, Akshay Verma (COO, SpotDraft)",
    "summary": "Building institutional memory from contract data: centralised, searchable contracts, fragmented knowledge, and contract intelligence that turns unstructured data into insights, with human judgment still essential.",
    "hook": "Ask how easily they can find terms, obligations and trends across their contracts today."
  },
  "62694696340": {
    "title": "The GC Influence & Getting Buy-In Playbook (Sarah Ouis workshop)",
    "speakers": "Sarah Ouis (Founder, GC Rendez-Vous), Lily Schurra (Associate GC, Sourcegraph)",
    "summary": "The FRAME framework for winning stakeholder buy-in for CLM, headcount and budget: right stakeholder, their priorities, value in business terms, data, an easy ask. Using contract data, risk and opportunity cost to show business impact.",
    "hook": "Offer help building the business case for CLM (data, risk, opportunity cost) if they are seeking budget or buy-in."
  },
  "62800385568": {
    "title": "The State of In-House Legal Innovation in Europe 2026 (ITGC webinar)",
    "speakers": "Sarah Irwin (Founder, ITGC), Emilie Pounds, Helen Loots, Sabrina Pervez (Regional Director EMEA, SpotDraft)",
    "summary": "Findings from a survey of 80+ European GCs: where AI adoption pressure comes from, budgets and accuracy, innovation for lean teams, and balancing new tech with resources and processes.",
    "hook": "Ask where their team sits on AI adoption and what is holding them back (budget, accuracy, resources)."
  },
  "64015249835": {
    "title": "IHC Demo Day: Cut Through the Noise (Part Four)",
    "speakers": "Marshall Deutz (SpotDraft) with customer Floyd Swanton (VP Legal, Lightcast)",
    "summary": "Demo day session moderated by Marshall alongside SpotDraft customer Lightcast.",
    "hook": "They heard a customer story (Lightcast): offer a deeper demo or a customer reference conversation."
  },
  "64507878486": {
    "title": "We Bought a CLM. Now What? (ITGC x SpotDraft)",
    "speakers": "Sarah Irwin (Founder, ITGC), Hylton Lütge (Head of Legal, Cera Health), Sabrina Pervez (Head of GTM EMEA, SpotDraft)",
    "summary": "Life after buying a CLM: Cera Health's journey with SpotDraft (before, decision factors, implementation), preparing for rollout, driving adoption and moving off manual processes.",
    "hook": "Ask whether they already have a CLM and how adoption is going, or how they would approach implementation."
  },
  "64633379394": {
    "title": "The Hidden Cost of Bad Contracts: How Revenue Leaks Through Legal Gaps (IHC webinar)",
    "speakers": "David Hirsch (Head of Commercial & Contract Management NA, Capgemini), Richa Fortuna (Director & AGC, Capital One), Sabrina Pervez (Head of GTM EMEA, SpotDraft)",
    "summary": "Post-signature revenue leakage: missed price increases, outdated renewals, unclaimed rebates, untracked obligations and unbilled scope changes; better legal-finance-sales handovers, reviewing high-value contracts, CLM and AI to track obligations.",
    "hook": "Ask how they track renewals, price increases and obligations after signature."
  },
  "65210924468": {
    "title": "Visual Literacy for Lawyers (masterclass / fireside chat)",
    "speakers": "Tessa Manuello (Founder & CEO, Legal Creatives), Linsey Krolik (Privacy, Product & AI Governance, Credo AI), Olga V. Mack (CEO, TermScout), Akshay Verma (COO, SpotDraft)",
    "summary": "Making contracts easier to understand and use: start small, find recurring clarification requests or execution issues, pilot, and design visuals around the decision they support.",
    "hook": "Ask where the business keeps coming back to legal with questions about contracts."
  },
  "65464494921": {
    "title": "From Playbook to Practice: Making Contract Playbooks Work (How to Contract webinar, Laura Frederick)",
    "speakers": "Aprajita Tyagi (Senior Corporate Counsel, Miro), Anna Pototschnig (Senior Legal Counsel, Calix), Marshall Deutz (SpotDraft)",
    "summary": "Playbooks as decision tools: accept / negotiate / escalate tiers, the protection behind each position, exceptions to the right approver, playbooks inside the CLM, and tracking deviations to keep them current.",
    "hook": "Ask whether their playbook lives in a PDF or inside their tools, and how they track deviations."
  },
  "65798239604": {
    "title": "The Buyer's Guide to Contract Management: 5 Questions to Ask (SpotDraft x Mango Cloud)",
    "speakers": "Naomi Thompson (Founder, CatalyNT), Mpho Chitapi (Group Legal Technology Head, Nedbank), Sabrina Pervez (Head of GTM EMEA, SpotDraft)",
    "summary": "Evaluating CLM beyond shiny demos: start from the problem and measurable outcomes, involve Sales, Procurement and Finance, pilot with real contracts, prioritise high-risk contracts for migration, check data security and exit, judge AI on your own use cases.",
    "hook": "They are likely evaluating CLM: offer a pilot with their real contracts and ask what outcomes they will measure."
  }
};
