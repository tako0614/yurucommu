const PROBE_PATH = "/__takoform_v1_fetch_probe";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== PROBE_PATH) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET" },
      });
    }

    return Response.json({
      kind: "yurucommu.takoform-v1-fetch-probe@v1",
      nonce: env.PROBE_NONCE,
    });
  },
};
