const DEFAULT_ORIGIN = "https://blend-buddy.bentleyrpaul1.workers.dev";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function corsOrigin(request) {
  const origin = request.headers.get("Origin") || "";
  try {
    const url = new URL(origin);
    // Allow Blend Buddy's production Worker host and its preview/deployment
    // hosts. This fixes preflight failures if Cloudflare serves a deployment
    // hostname while keeping unrelated sites from using browser CORS.
    if (url.protocol === "https:" &&
        (url.hostname === "blend-buddy.bentleyrpaul1.workers.dev" ||
         url.hostname.endsWith(".blend-buddy.pages.dev") ||
         url.hostname.endsWith(".workers.dev"))) return origin;
  } catch {}
  return DEFAULT_ORIGIN;
}

function json(data, status = 200, origin = DEFAULT_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    }
  });
}

export default {
  async fetch(request, env) {
    const origin = corsOrigin(request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
      }});
    }
    const pathname = new URL(request.url).pathname;
    if (!["/identify", "/chef"].includes(pathname)) return json({ error: "Not found." }, 404);
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    if (!env.OPENAI_API_KEY) return json({ error: "The AI service is not configured. Add the OPENAI_API_KEY secret to this Worker." }, 503);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Please send a valid request." }, 400); }

    if (pathname === "/chef") {
      const message = typeof body.message === "string" ? body.message.trim().slice(0, 2500) : "";
      if (!message) return json({ error: "Tell Chef what ingredients or flavors you want." }, 400);
      let upstream;
      try {
        upstream = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini", temperature: 0.6, max_tokens: 850,
            messages: [
              { role: "system", content: "You are Chef, the friendly recipe assistant for Blend Buddy, a website for easy smoothies and milkshakes. Recommend recipes based on ingredients, drink type, taste preferences, and constraints supplied by the user. Always give one clear best recommendation, a recipe name, ingredients with practical measurements (cups, tablespoons, teaspoons, and mL/g where useful), numbered blending instructions, easy substitutions, and a brief allergy-label reminder when relevant. Use only plausible edible ingredients and never claim a recipe is high-protein unless protein ingredients are included. Protein powder is optional and should follow its package serving directions. Ask a brief clarifying question only if the request truly cannot be answered. Keep replies friendly and organized with plain text headings. Do not give medical advice." },
              { role: "user", content: message }
            ]
          })
        });
      } catch {
        return json({ error: "Chef couldn't reach the AI service. Please try again." }, 502);
      }
      if (!upstream.ok) {
        const status = upstream.status === 429 ? 429 : 502;
        return json({ error: upstream.status === 401 ? "The AI service key needs checking in Cloudflare." : upstream.status === 429 ? "The AI service is busy or its usage limit was reached. Check API credits or try again shortly." : "Chef couldn't finish that recipe. Please try again." }, status);
      }
      let payload;
      try { payload = await upstream.json(); } catch { return json({ error: "Chef received an unreadable response." }, 502); }
      const reply = payload.choices?.[0]?.message?.content;
      if (typeof reply !== "string" || !reply.trim()) return json({ error: "Chef didn't return a recipe. Please try again." }, 502);
      return json({ reply: reply.trim() }, 200, origin);
    }

    const dataUrl = body && body.image;
    if (typeof dataUrl !== "string" || !/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
      return json({ error: "Choose a JPEG, PNG, WEBP, or GIF image." }, 400);
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (base64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3)) return json({ error: "That photo is too large. Please use an image under 5 MB." }, 413);

    const prompt = `Identify visible food ingredients that could be used in a smoothie or milkshake. Return only JSON in this shape: {"ingredients":[{"name":"banana","confidence":"high"}]}. Use short canonical ingredient names. Only include ingredients clearly visible; do not infer hidden items, quantities, freshness, or food safety. Prefer names from this list when applicable: banana, strawberry, blueberry, mango, peach, watermelon, milk, yogurt, peanut butter, protein powder, chocolate, vanilla ice cream, oats, honey, orange juice, spinach, pineapple, raspberry, apple, cinnamon, coffee, almond milk, soy milk, coconut milk, dates, avocado, cocoa powder, whipped cream. Include other clearly visible food ingredients if needed. Return at most 20 items and no markdown.`;
    let upstream;
    try {
      upstream = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0,
          max_tokens: 500,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "You identify visible food ingredients from photos. Be conservative and return valid JSON only." },
            { role: "user", content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } }
            ]}
          ]
        })
      });
    } catch {
      return json({ error: "Couldn't reach the image recognition service. Please try again." }, 502);
    }
    if (!upstream.ok) {
      const status = upstream.status === 429 ? 429 : 502;
      return json({ error: upstream.status === 401 ? "The AI service key needs checking in Cloudflare." : upstream.status === 429 ? "The AI service is busy or its usage limit was reached. Try again later." : "Image recognition couldn't complete. Please try again." }, status);
    }
    let payload;
    try { payload = await upstream.json(); } catch { return json({ error: "The AI returned an unreadable response." }, 502); }
    try {
      const parsed = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
      const allowed = new Set(["banana","strawberry","blueberry","mango","peach","watermelon","milk","yogurt","peanut butter","protein powder","chocolate","vanilla ice cream","oats","honey","orange juice","spinach","pineapple","raspberry","apple","cinnamon","coffee","almond milk","soy milk","coconut milk","dates","avocado","cocoa powder","whipped cream"]);
      const ingredients = [...new Set((Array.isArray(parsed.ingredients) ? parsed.ingredients : [])
        .map(x => String(x?.name || "").trim().toLowerCase())
        .filter(x => allowed.has(x)))].slice(0, 20);
      return json({ ingredients });
    } catch {
      return json({ error: "Couldn't read the ingredients from that photo. Try a clearer picture." }, 502);
    }
  }
};
