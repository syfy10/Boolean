const RULES = [
  {
    id: "wordpress", name: "WordPress", category: "CMS",
    signals: [
      [/wp-content\//i, 35, "wp-content assets"],
      [/wp-includes\//i, 25, "wp-includes assets"],
      [/<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*wordpress/i, 45, "WordPress generator meta"],
      [/\/wp-json\b/i, 30, "wp-json API reference"],
      [/woocommerce/i, 18, "WooCommerce/WordPress text"]
    ]
  },
  {
    id: "shopify", name: "Shopify", category: "Ecommerce",
    signals: [
      [/cdn\.shopify\.com|\/cdn\/shop\//i, 40, "Shopify CDN assets"],
      [/\bShopify\b|ShopifyAnalytics|shopify-features/i, 35, "Shopify JavaScript globals"],
      [/\/cart\.js\b|\/products\/[^"'\s]+\.js\b/i, 25, "Shopify storefront endpoints"],
      [/myshopify\.com/i, 30, "myshopify domain"]
    ]
  },
  {
    id: "wix", name: "Wix", category: "Website builder",
    signals: [
      [/static\.wixstatic\.com|wix-code|wixsite\.com/i, 45, "Wix assets/domain"],
      [/X-Wix-/i, 35, "Wix header or marker"],
      [/\bWix\b.*(?:Renderer|Thunderbolt|Stores)/i, 25, "Wix runtime marker"]
    ]
  },
  {
    id: "webflow", name: "Webflow", category: "Website builder",
    signals: [
      [/webflow\.js|uploads-ssl\.webflow\.com|assets\.website-files\.com/i, 45, "Webflow assets"],
      [/data-wf-page|data-wf-site/i, 40, "Webflow data attributes"],
      [/<html[^>]+data-wf-/i, 30, "Webflow HTML marker"]
    ]
  },
  {
    id: "squarespace", name: "Squarespace", category: "Website builder",
    signals: [
      [/static1\.squarespace\.com|squarespace-cdn\.com/i, 45, "Squarespace CDN"],
      [/Static\.SQUARESPACE_CONTEXT|Y\.Squarespace/i, 35, "Squarespace runtime"],
      [/squarespace\.com\/universal/i, 25, "Squarespace universal asset"]
    ]
  },
  {
    id: "framer", name: "Framer", category: "Website builder",
    signals: [
      [/framerusercontent\.com|framer\.com\/m\//i, 45, "Framer assets"],
      [/data-framer-|__framer/i, 35, "Framer runtime marker"]
    ]
  },
  {
    id: "nextjs", name: "Next.js", category: "Frontend framework",
    signals: [
      [/<script[^>]+id=["']__NEXT_DATA__["']/i, 55, "__NEXT_DATA__ script"],
      [/_next\/(?:static|image)\//i, 40, "_next assets"],
      [/next-head-count/i, 25, "Next.js head marker"]
    ]
  },
  {
    id: "react", name: "React", category: "Frontend framework",
    signals: [
      [/react(?:\.production\.min)?\.js|react-dom/i, 35, "React assets"],
      [/data-reactroot|__REACT_DEVTOOLS_GLOBAL_HOOK__|react-refresh/i, 35, "React runtime marker"],
      [/\bReact\b/i, 12, "React text marker"]
    ]
  },
  {
    id: "vue", name: "Vue", category: "Frontend framework",
    signals: [
      [/vue(?:\.runtime)?(?:\.global|\.esm|\.min)?\.js/i, 40, "Vue asset"],
      [/data-v-[a-f0-9]{6,}|__VUE__/i, 35, "Vue scoped/runtime marker"],
      [/\bNuxt\b|__NUXT__/i, 25, "Nuxt marker"]
    ]
  },
  {
    id: "angular", name: "Angular", category: "Frontend framework",
    signals: [
      [/ng-version|ng-app|_ngcontent-/i, 45, "Angular DOM marker"],
      [/angular(?:\.min)?\.js|@angular/i, 35, "Angular asset"]
    ]
  },
  {
    id: "svelte", name: "Svelte", category: "Frontend framework",
    signals: [
      [/svelte-[a-z0-9]+/i, 40, "Svelte scoped class"],
      [/_app\/immutable\/|data-svelte/i, 35, "SvelteKit asset/marker"]
    ]
  },
  {
    id: "astro", name: "Astro", category: "Frontend framework",
    signals: [
      [/astro-[a-z0-9]+|data-astro/i, 45, "Astro island/attribute"],
      [/_astro\//i, 40, "Astro asset path"]
    ]
  },
  {
    id: "tailwind", name: "Tailwind CSS", category: "CSS/UI",
    signals: [
      [/tailwind(?:\.min)?\.css|cdn\.tailwindcss\.com/i, 45, "Tailwind asset"],
      [/\b(?:sm:|md:|lg:|xl:)?(?:flex|grid|text-[a-z0-9-]+|bg-[a-z0-9-]+|rounded-[a-z0-9-]+|space-y-\d)/i, 20, "Tailwind utility classes"]
    ]
  },
  {
    id: "bootstrap", name: "Bootstrap", category: "CSS/UI",
    signals: [
      [/bootstrap(?:\.bundle)?(?:\.min)?\.(?:css|js)/i, 45, "Bootstrap asset"],
      [/\b(?:container-fluid|row|col-md-|navbar|btn-primary)\b/i, 25, "Bootstrap classes"]
    ]
  },
  {
    id: "gtm", name: "Google Tag Manager", category: "Analytics",
    signals: [[/googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/i, 60, "GTM script/container"]]
  },
  {
    id: "ga", name: "Google Analytics", category: "Analytics",
    signals: [[/google-analytics\.com\/analytics\.js|googletagmanager\.com\/gtag\/js|G-[A-Z0-9]+/i, 55, "GA script/measurement id"]]
  },
  {
    id: "meta-pixel", name: "Meta Pixel", category: "Analytics",
    signals: [[/connect\.facebook\.net\/[^"']*\/fbevents\.js|fbq\(/i, 55, "Meta Pixel script"]]
  },
  {
    id: "cloudflare", name: "Cloudflare", category: "Hosting/CDN",
    signals: [
      [/cf-ray|server:\s*cloudflare/i, 45, "Cloudflare response header"],
      [/cdnjs\.cloudflare\.com|cloudflareinsights\.com|__cf_bm/i, 35, "Cloudflare asset/cookie"]
    ]
  },
  {
    id: "vercel", name: "Vercel", category: "Hosting/CDN",
    signals: [[/x-vercel-|vercel\.app|_vercel/i, 50, "Vercel header/domain"]]
  },
  {
    id: "netlify", name: "Netlify", category: "Hosting/CDN",
    signals: [[/x-nf-|netlify\.app|netlify\.com/i, 50, "Netlify header/domain"]]
  }
];

function clampScore(score) {
  return Math.max(1, Math.min(99, Math.round(score)));
}

export function detectWebsiteTech(input = {}) {
  const html = String(input.html || "");
  const url = String(input.url || "");
  const headers = input.headers && typeof input.headers === "object"
    ? Object.entries(input.headers).map(([k, v]) => `${k}: ${v}`).join("\n")
    : "";
  const cookies = Array.isArray(input.cookies) ? input.cookies.join("\n") : String(input.cookies || "");
  const haystack = [url, headers, cookies, html].join("\n");
  const detected = [];

  for (const rule of RULES) {
    let score = 0;
    const signals = [];
    for (const [pattern, weight, label] of rule.signals) {
      if (pattern.test(haystack)) {
        score += weight;
        signals.push(label);
      }
    }
    if (score > 0) {
      detected.push({
        id: rule.id,
        name: rule.name,
        category: rule.category,
        confidence: clampScore(score),
        signals
      });
    }
  }

  detected.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  const categories = {};
  for (const item of detected) {
    categories[item.category] = categories[item.category] || [];
    categories[item.category].push(item);
  }
  return {
    url,
    detected,
    categories,
    privacy: "Analyzed locally inside Boolean. No third-party detection API was called."
  };
}
