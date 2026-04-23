import crypto from "crypto";

const TIKTOK_TRACK_URL = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
const PIXEL_CODE = "D7II9M3C77UEMEL8DQ40";
const EVENT_NAME = "Lead";
const EVENT_SOURCE = "web";
const TEST_EVENT_CODE = "TEST69861";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256Hex(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function normalizePhone(phone) {
  const trimmed = phone.trim();
  const digitsOnly = trimmed.replace(/[^\d]/g, "");
  return digitsOnly;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonError(res, status, message, details) {
  res.status(status).json({ error: message, ...(details ? { details } : {}) });
}

export default async function handler(req, res) {
  const requestId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : sha256Hex(String(Date.now()) + String(Math.random())).slice(0, 32);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return jsonError(res, 405, "Method Not Allowed");
  }

  if (!process.env.TIKTOK_ACCESS_TOKEN) {
    console.error(`[tiktok][${requestId}] Missing TIKTOK_ACCESS_TOKEN`);
    return jsonError(res, 500, "Server misconfiguration");
  }

  if (!isPlainObject(req.body)) {
    console.warn(`[tiktok][${requestId}] Invalid JSON body shape`);
    return jsonError(res, 400, "Invalid JSON body; expected an object");
  }

  const phone = req.body.phone;
  const ttclid = req.body.ttclid;
  const externalId = req.body.external_id;

  const validationErrors = {};

  if (typeof phone !== "string" || phone.trim().length === 0) {
    validationErrors.phone = "phone is required and must be a non-empty string";
  }

  if (typeof ttclid !== "string" || ttclid.trim().length === 0) {
    validationErrors.ttclid = "ttclid is required and must be a non-empty string";
  }

  if (typeof externalId !== "string" || externalId.trim().length === 0) {
    validationErrors.external_id =
      "external_id is required and must be a non-empty string";
  }

  if (Object.keys(validationErrors).length > 0) {
    console.warn(`[tiktok][${requestId}] Validation failed`, {
      fields: Object.keys(validationErrors),
    });
    return jsonError(res, 400, "Validation error", validationErrors);
  }

  let phoneHashed;
  const phoneTrimmed = phone.trim();

  if (isSha256Hex(phoneTrimmed)) {
    phoneHashed = phoneTrimmed.toLowerCase();
  } else {
    const normalized = normalizePhone(phoneTrimmed);
    if (normalized.length < 7 || normalized.length > 15) {
      console.warn(`[tiktok][${requestId}] Invalid phone format`, {
        length: normalized.length,
      });
      return jsonError(res, 400, "Validation error", {
        phone: "phone must be a valid phone number or a SHA256 hex hash",
      });
    }
    phoneHashed = sha256Hex(normalized);
  }

  const eventTime = Math.floor(Date.now() / 1000);

  const payload = {
    pixel_code: PIXEL_CODE,
    event: EVENT_NAME,
    event_source: EVENT_SOURCE,
    event_source_id: PIXEL_CODE,
    test_event_code: TEST_EVENT_CODE,
    data: [
      {
        event: EVENT_NAME,
        event_time: eventTime,
        user: {
          phone: phoneHashed,
          ttclid: ttclid.trim(),
          external_id: externalId.trim(),
        },
      },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    console.info(`[tiktok][${requestId}] Sending event`, {
      event: EVENT_NAME,
      event_time: eventTime,
    });

    const tiktokRes = await fetch(TIKTOK_TRACK_URL, {
      method: "POST",
      headers: {
        "Access-Token": process.env.TIKTOK_ACCESS_TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const contentType = tiktokRes.headers.get("content-type") || "";
    const isJson = contentType.toLowerCase().includes("application/json");
    const responseBody = isJson ? await tiktokRes.json() : await tiktokRes.text();

    if (tiktokRes.ok) {
      console.info(`[tiktok][${requestId}] TikTok API success`, {
        status: tiktokRes.status,
      });
    } else {
      console.error(`[tiktok][${requestId}] TikTok API error`, {
        status: tiktokRes.status,
      });
    }

    if (isJson) {
      return res.status(tiktokRes.status).json(responseBody);
    }

    res.status(tiktokRes.status);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(responseBody);
  } catch (err) {
    const isAbortError =
      err && typeof err === "object" && (err.name === "AbortError" || err.code === "ABORT_ERR");

    console.error(`[tiktok][${requestId}] Request failed`, {
      reason: isAbortError ? "timeout" : "network_or_runtime_error",
      message: err instanceof Error ? err.message : String(err),
    });

    return jsonError(res, 502, "Upstream request failed", {
      reason: isAbortError ? "timeout" : "network_or_runtime_error",
    });
  } finally {
    clearTimeout(timeout);
  }
}
