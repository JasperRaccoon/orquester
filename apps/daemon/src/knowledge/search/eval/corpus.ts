/**
 * The retrieval evaluation set (retrieval spec P0.4): short entries in English and Spanish on the
 * overlapping topics of the real knowledge base (SEO, ads, mobile apps, TikTok, paywalls, landing
 * pages), with hard negatives (SaaS annual billing next to paywall annual plans, scaling an ad
 * budget next to the learning phase) and two near-copies (reposts) for the duplicate threshold;
 * and queries in English, Spanish and across the two, each with the entries that answer it.
 * Fixed: changing it changes the recorded calibration (`install/pins.ts`).
 */

export type EvalTopic = "seo" | "ads" | "apps" | "tiktok" | "paywalls" | "landing" | "saas";

export interface EvalEntry {
  id: string;
  title: string;
  author: string | null;
  handle: string | null;
  kind: string;
  lang: "en" | "es";
  topic: EvalTopic;
  body: string;
  /** A near-copy (a repost) of this entry. */
  duplicateOf?: string;
}

export interface EvalQuery {
  text: string;
  /** The query's language, and the expected entries' when they differ. */
  lang: "en" | "es" | "en→es" | "es→en";
  /** The entries that answer it (recall counts every one). */
  expected: readonly string[];
}

export const EVAL_ENTRIES: readonly EvalEntry[] = [
  // ---- SEO
  {
    id: "ke_seo_alternatives",
    title: "Alternatives pages",
    author: "Kevin Indig",
    handle: "kevin_indig",
    kind: "tweet",
    lang: "en",
    topic: "seo",
    body: "Alternatives pages convert well. Write one page per competitor, \"[competitor] alternatives\" and \"[competitor] vs [you]\", with an honest comparison table. They capture people who are already shopping and rank fast because few sites bother."
  },
  {
    id: "ke_seo_ai_citations",
    title: "How Cloudflare got cited by AI answer engines",
    author: "Ross Hudgens",
    handle: "rosshudgens",
    kind: "article",
    lang: "en",
    topic: "seo",
    body: "Case study: Cloudflare shows up in ChatGPT, Perplexity and Gemini answers because it publishes original data and clearly structured comparison tables. LLMs quote pages that state facts plainly, so lead each section with the answer."
  },
  {
    id: "ke_seo_enlazado_interno",
    title: "Enlazado interno para posicionar",
    author: "Laura Gómez",
    handle: "lauraseo",
    kind: "tweet",
    lang: "es",
    topic: "seo",
    body: "El enlazado interno es la palanca de SEO más infravalorada. Enlaza desde tus artículos con más autoridad hacia las páginas que quieres posicionar en Google y usa textos ancla descriptivos, no \"haz clic aquí\"."
  },
  {
    id: "ke_seo_programmatic",
    title: "Programmatic SEO with templates",
    author: "Ian Nuttall",
    handle: "iannuttall",
    kind: "thread",
    lang: "en",
    topic: "seo",
    body: "Programmatic SEO: build one template and generate thousands of pages from a database, like \"best coworking spaces in [city]\". It only works when every page has unique, useful data; thin pages get deindexed."
  },
  {
    id: "ke_seo_long_tail",
    title: "Palabras clave de cola larga",
    author: "Laura Gómez",
    handle: "lauraseo",
    kind: "note",
    lang: "es",
    topic: "seo",
    body: "Las búsquedas de cola larga tienen menos competencia y una intención de compra más clara. Empieza por palabras clave de tres o más términos donde un blog nuevo pueda llegar a la primera página."
  },
  // ---- Ads
  {
    id: "ke_ads_learning",
    title: "Ads learning phase",
    author: "Savannah Sanchez",
    handle: "savsanchez",
    kind: "tweet",
    lang: "en",
    topic: "ads",
    body: "While a Meta campaign is in the learning phase, don't touch it. Cap the daily budget, don't edit the ads or the audience, and wait for about 50 conversions before you judge the results; every edit restarts learning."
  },
  {
    id: "ke_ads_learning_repost",
    title: "Ads learning phase (repost)",
    author: "Growth Digest",
    handle: "growthdigest",
    kind: "tweet",
    lang: "en",
    topic: "ads",
    duplicateOf: "ke_ads_learning",
    body: "While a Meta campaign is in the learning phase, don't touch it! Cap the daily budget, don't edit the ads or the audience, and wait for roughly 50 conversions before judging results, because every edit restarts learning."
  },
  {
    id: "ke_ads_creativos",
    title: "Rotación de creatividades en Meta Ads",
    author: "Pablo Ruiz",
    handle: "pabloads",
    kind: "thread",
    lang: "es",
    topic: "ads",
    body: "La fatiga creativa hace que el CPM suba y el CTR baje. Renueva los anuncios cada dos semanas y prueba entre tres y cinco ganchos distintos por conjunto de anuncios en Facebook e Instagram."
  },
  {
    id: "ke_ads_retargeting",
    title: "Retargeting windows",
    author: "Depesh Mandalia",
    handle: "depeshm",
    kind: "article",
    lang: "en",
    topic: "ads",
    body: "Split retargeting audiences by recency: visitors from the last 1–7 days get a direct offer, 8–30 days get social proof. Always exclude people who already bought, and set a frequency cap so the same person does not see the ad twenty times."
  },
  {
    id: "ke_ads_presupuesto",
    title: "Cómo escalar el presupuesto de las campañas",
    author: "Pablo Ruiz",
    handle: "pabloads",
    kind: "tweet",
    lang: "es",
    topic: "ads",
    body: "Para escalar una campaña rentable, sube el presupuesto como mucho un 20 % cada tres días; un salto mayor reinicia la fase de aprendizaje del algoritmo. Si necesitas crecer más rápido, duplica el conjunto de anuncios ganador."
  },
  {
    id: "ke_ads_google_brand",
    title: "Bid on your own brand",
    author: "Kirk Williams",
    handle: "ppckirk",
    kind: "tweet",
    lang: "en",
    topic: "ads",
    body: "Bid on your own brand keywords in Google Ads. Competitors are buying them, brand clicks cost cents, and the brand campaign lets you control the message and the sitelinks people see."
  },
  // ---- Mobile apps
  {
    id: "ke_app_aso_screenshots",
    title: "App Store screenshots that convert",
    author: "Lukas Hermann",
    handle: "lukasaso",
    kind: "thread",
    lang: "en",
    topic: "apps",
    body: "Most people never scroll past the first two App Store screenshots, so they must sell the main benefit. Use short captions that describe outcomes, not features, and test them with product page optimization."
  },
  {
    id: "ke_app_valoraciones",
    title: "Pedir valoraciones en el momento justo",
    author: "Marta Vidal",
    handle: "martamobile",
    kind: "note",
    lang: "es",
    topic: "apps",
    body: "Muestra la ventana de reseñas de la App Store justo después de un logro del usuario, por ejemplo al terminar su primer objetivo, nunca al abrir la app. Así las valoraciones de cinco estrellas suben mucho."
  },
  {
    id: "ke_app_onboarding",
    title: "Onboarding that activates",
    author: "Jacob Rushfinn",
    handle: "jacobrushfinn",
    kind: "article",
    lang: "en",
    topic: "apps",
    body: "Keep the app onboarding short: ask two or three personalization questions, show the user a result right away, and only then ask for notification permission, once they have seen the value."
  },
  {
    id: "ke_app_retencion",
    title: "Retención del día 1 en apps móviles",
    author: "Marta Vidal",
    handle: "martamobile",
    kind: "thread",
    lang: "es",
    topic: "apps",
    body: "Si la retención del día 1 de tu app está por debajo del 25 %, la mayoría de usuarios se va tras la primera sesión. Revisa el onboarding y envía una notificación push útil a las 24 horas para que vuelvan."
  },
  {
    id: "ke_app_aso_keywords",
    title: "The App Store keyword field",
    author: "Lukas Hermann",
    handle: "lukasaso",
    kind: "note",
    lang: "en",
    topic: "apps",
    body: "App Store Connect gives you a 100-character keyword field. Separate keywords with commas and no spaces, don't repeat words already in your app name or subtitle, and localize it for every storefront."
  },
  // ---- TikTok
  {
    id: "ke_tiktok_hooks",
    title: "TikTok hooks in the first second",
    author: "Ali Abdaal",
    handle: "aliabdaal",
    kind: "tweet",
    lang: "en",
    topic: "tiktok",
    body: "On TikTok you have one second to stop the scroll. Open with the outcome, put bold text on screen, and start mid-action; never open with \"hey guys\" or a logo."
  },
  {
    id: "ke_tiktok_hooks_repost",
    title: "TikTok hooks (repost)",
    author: "Creator Notes",
    handle: "creatornotes",
    kind: "tweet",
    lang: "en",
    topic: "tiktok",
    duplicateOf: "ke_tiktok_hooks",
    body: "On TikTok you have one second to stop the scroll: open with the outcome, put bold text on the screen and start mid-action. Never open with \"hey guys\" or with a logo."
  },
  {
    id: "ke_tiktok_ugc",
    title: "Creadores UGC para anuncios en TikTok",
    author: "Sofía Martín",
    handle: "sofiaugc",
    kind: "thread",
    lang: "es",
    topic: "tiktok",
    body: "Contrata creadores de contenido UGC para tus anuncios de TikTok: graban el producto con su móvil y parecen recomendaciones reales. Promociona sus vídeos con Spark Ads desde su propia cuenta."
  },
  {
    id: "ke_tiktok_posting",
    title: "Posting cadence on TikTok",
    author: "Chris Do",
    handle: "thechrisdo",
    kind: "tweet",
    lang: "en",
    topic: "tiktok",
    body: "Post on TikTok one to three times a day and stay consistent for at least a month. The algorithm shows every video to a small test audience first, so volume gives you more chances to break out."
  },
  {
    id: "ke_tiktok_organico_app",
    title: "Crecer una app con TikTok orgánico",
    author: "Sofía Martín",
    handle: "sofiaugc",
    kind: "article",
    lang: "es",
    topic: "tiktok",
    body: "Para crecer una app sin pagar anuncios, abre varias cuentas de TikTok sin cara que muestren la app resolviendo un problema concreto. Pon el enlace de descarga en la bio y publica a diario."
  },
  {
    id: "ke_tiktok_shop",
    title: "TikTok Shop affiliates",
    author: "Nick Shackelford",
    handle: "nickshack",
    kind: "tweet",
    lang: "en",
    topic: "tiktok",
    body: "TikTok Shop's affiliate program lets creators earn a commission on every sale they drive. Send free samples to fifty small creators and keep working with the ones whose videos sell."
  },
  // ---- Paywalls
  {
    id: "ke_paywall_annual",
    title: "Preselect the annual plan on the paywall",
    author: "Jacob Rushfinn",
    handle: "jacobrushfinn",
    kind: "thread",
    lang: "en",
    topic: "paywalls",
    body: "On a subscription app paywall, preselect the yearly plan, show its price per month next to the monthly plan, and add a \"save 50%\" badge. Most of our trials started on the annual plan after this change."
  },
  {
    id: "ke_paywall_trial",
    title: "Prueba gratuita de 7 días frente a 3 días",
    author: "Marta Vidal",
    handle: "martamobile",
    kind: "note",
    lang: "es",
    topic: "paywalls",
    body: "En nuestra app, la prueba gratuita de 7 días convirtió a pago mejor que la de 3 días: los usuarios tuvieron tiempo de crear el hábito antes del primer cobro de la suscripción."
  },
  {
    id: "ke_paywall_onboarding",
    title: "Show the paywall at the end of onboarding",
    author: "Phil Carter",
    handle: "philcarter",
    kind: "article",
    lang: "en",
    topic: "paywalls",
    body: "Show a hard paywall right at the end of onboarding, while motivation is highest. In our apps most subscription revenue comes from the first session; users who skip it rarely come back to pay."
  },
  {
    id: "ke_paywall_precios",
    title: "Experimentos de precio en suscripciones",
    author: "Pablo Ruiz",
    handle: "pabloads",
    kind: "thread",
    lang: "es",
    topic: "paywalls",
    body: "Haz pruebas A/B de precio con RevenueCat. Subimos la suscripción anual de 39,99 € a 49,99 € y la conversión apenas cambió, así que los ingresos por usuario crecieron un 20 %."
  },
  {
    id: "ke_saas_annual_billing",
    title: "Annual billing",
    author: null,
    handle: null,
    kind: "note",
    lang: "en",
    topic: "saas",
    body: "Annual billing with a discount lifts cash flow for a B2B SaaS. Stripe handles proration when a customer upgrades mid-year, and invoices can be sent to the finance team."
  },
  // ---- Landing pages
  {
    id: "ke_landing_hero",
    title: "Landing page hero section",
    author: "Harry Dry",
    handle: "harrydry",
    kind: "tweet",
    lang: "en",
    topic: "landing",
    body: "The hero section of a landing page needs a headline with the outcome, a subheadline with how you deliver it, and one call to action above the fold. Everything else can wait for the scroll."
  },
  {
    id: "ke_landing_velocidad",
    title: "Velocidad de carga de la landing",
    author: "Laura Gómez",
    handle: "lauraseo",
    kind: "note",
    lang: "es",
    topic: "landing",
    body: "Cada segundo que tarda en cargar tu página de aterrizaje resta conversiones. Comprime las imágenes, quita los carruseles y los scripts que no uses, y mide con PageSpeed en el móvil."
  },
  {
    id: "ke_landing_social_proof",
    title: "Social proof next to the CTA",
    author: "Harry Dry",
    handle: "harrydry",
    kind: "tweet",
    lang: "en",
    topic: "landing",
    body: "Put testimonials with real faces and concrete numbers right next to the signup button. Social proof works best where the visitor hesitates, not in a section at the bottom of the page."
  }
];

export const EVAL_QUERIES: readonly EvalQuery[] = [
  // English
  { text: "pages comparing my product with competitors", lang: "en", expected: ["ke_seo_alternatives"] },
  { text: "get my site cited in ChatGPT answers", lang: "en", expected: ["ke_seo_ai_citations"] },
  { text: "why not edit a campaign while it is still learning", lang: "en", expected: ["ke_ads_learning", "ke_ads_learning_repost"] },
  { text: "which app store screenshots convert best", lang: "en", expected: ["ke_app_aso_screenshots"] },
  { text: "what to say in the first seconds of a short video", lang: "en", expected: ["ke_tiktok_hooks", "ke_tiktok_hooks_repost"] },
  { text: "should the paywall preselect the yearly subscription", lang: "en", expected: ["ke_paywall_annual"] },
  { text: "headline and call to action above the fold", lang: "en", expected: ["ke_landing_hero"] },
  { text: "how often should I post on TikTok", lang: "en", expected: ["ke_tiktok_posting"] },
  // Spanish
  { text: "cómo conseguir más reseñas de cinco estrellas en mi app", lang: "es", expected: ["ke_app_valoraciones"] },
  { text: "cuántos días debe durar la prueba gratis", lang: "es", expected: ["ke_paywall_trial"] },
  { text: "enlaces internos para subir en Google", lang: "es", expected: ["ke_seo_enlazado_interno"] },
  { text: "anuncios grabados por creadores de contenido", lang: "es", expected: ["ke_tiktok_ugc"] },
  { text: "mi web tarda mucho en cargar y pierdo ventas", lang: "es", expected: ["ke_landing_velocidad"] },
  { text: "subir el precio de la suscripción sin perder conversión", lang: "es", expected: ["ke_paywall_precios"] },
  // Across languages
  { text: "creative fatigue on Facebook ads", lang: "en→es", expected: ["ke_ads_creativos"] },
  { text: "users leave my app after the first day", lang: "en→es", expected: ["ke_app_retencion"] },
  { text: "how to scale ad spend without resetting the algorithm", lang: "en→es", expected: ["ke_ads_presupuesto"] },
  { text: "grow a mobile app with organic short videos", lang: "en→es", expected: ["ke_tiktok_organico_app"] },
  { text: "generar miles de páginas desde una base de datos", lang: "es→en", expected: ["ke_seo_programmatic"] },
  { text: "cuándo mostrar el muro de pago a los usuarios nuevos", lang: "es→en", expected: ["ke_paywall_onboarding"] },
  { text: "testimonios junto al botón de registro", lang: "es→en", expected: ["ke_landing_social_proof"] },
  { text: "palabras clave en App Store Connect", lang: "es→en", expected: ["ke_app_aso_keywords"] }
];
