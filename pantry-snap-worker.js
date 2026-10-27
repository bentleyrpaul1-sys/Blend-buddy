const ALLOWED_ORIGIN = "https://blend-buddy.bentleyrpaul1.workers.dev";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function json(data, status = 200, origin = ALLOWED_ORIGIN) {
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
    const origin = request.headers.get("Origin") || "";
    if (origin !== ALLOWED_ORIGIN) return json({ error: "Origin not allowed." }, 403, ALLOWED_ORIGIN);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
      }});
    }
    if (new URL(request.url).pathname !== "/identify") return json({ error: "Not found." }, 404);
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    if (!env.OPENAI_API_KEY) return json({ error: "Pantry Snap AI is not configured yet. Add the OPENAI_API_KEY secret to this Worker." }, 503);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Please upload a valid image." }, 400); }
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
