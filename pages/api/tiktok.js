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

function validateNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hashPhoneOrThrow(phone, requestId) {
  const phoneTrimmed = phone.trim();
  if (isSha256Hex(phoneTrimmed)) {
    return phoneTrimmed.toLowerCase();
  }

  const normalized = normalizePhone(phoneTrimmed);
  if (normalized.length < 7 || normalized.length > 15) {
    console.warn(`[tiktok][${requestId}] Invalid phone format`, {
      length: normalized.length,
    });
    const error = new Error("invalid_phone");
    error.code = "invalid_phone";
    throw error;
  }
  return sha256Hex(normalized);
}

export default async function handler(req, res) {
  const requestId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : sha256Hex(String(Date.now()) + String(Math.random())).slice(0, 32);

  res.setHeader("X-Request-Id", requestId);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return jsonError(res, 405, "Method Not Allowed");
  }

  console.info(`[tiktok][${requestId}] Incoming request`, {
    method: req.method,
    content_type: req.headers["content-type"],
    body_is_object: isPlainObject(req.body),
    body_keys: isPlainObject(req.body) ? Object.keys(req.body) : null,
  });

  if (!process.env.TIKTOK_ACCESS_TOKEN) {
    console.error(`[tiktok][${requestId}] Missing TIKTOK_ACCESS_TOKEN`);
    return jsonError(res, 500, "Server misconfiguration");
  }

  if (!isPlainObject(req.body)) {
    console.warn(`[tiktok][${requestId}] Invalid JSON body shape`);
    return jsonError(res, 400, "Invalid JSON body; expected an object");
  }

  const eventTime = Math.floor(Date.now() / 1000);

  const body = req.body;
  let payload;

  const isStructured =
    Array.isArray(body.data) &&
    validateNonEmptyString(body.event_source) &&
    validateNonEmptyString(body.event_source_id);

  if (isStructured) {
    const validationErrors = {};

    const dataItems = body.data;
    if (dataItems.length === 0) {
      validationErrors.data = "data must be a non-empty array";
    }

    const normalizedData = [];

    for (let i = 0; i < dataItems.length; i += 1) {
      const item = dataItems[i];
      if (!isPlainObject(item)) {
        validationErrors[`data[${i}]`] = "each data item must be an object";
        continue;
      }

      const user = isPlainObject(item.user) ? { ...item.user } : {};

      if (!validateNonEmptyString(user.external_id)) {
        validationErrors[`data[${i}].user.external_id`] =
          "external_id is required and must be a non-empty string";
      }

      if (typeof user.phone === "string") {
        try {
          user.phone = hashPhoneOrThrow(user.phone, requestId);
        } catch (e) {
          validationErrors[`data[${i}].user.phone`] =
            "phone must be a valid phone number or a SHA256 hex hash";
        }
      }

      const pageFromItem = isPlainObject(item.page) ? { ...item.page } : null;
      const urlCandidate =
        (pageFromItem && typeof pageFromItem.url === "string" ? pageFromItem.url : null) ||
        (validateNonEmptyString(item.url) ? item.url : null) ||
        (validateNonEmptyString(item.page_url) ? item.page_url : null) ||
        (validateNonEmptyString(item.pageUrl) ? item.pageUrl : null) ||
        (validateNonEmptyString(user.url) ? user.url : null) ||
        (validateNonEmptyString(body.url) ? body.url : null) ||
        (validateNonEmptyString(req.headers.referer) ? req.headers.referer : null);

      const page =
        validateNonEmptyString(urlCandidate) ? { ...(pageFromItem || {}), url: urlCandidate.trim() } : pageFromItem;

      normalizedData.push({
        ...item,
        event: validateNonEmptyString(item.event) ? item.event.trim() : EVENT_NAME,
        event_time: eventTime,
        user,
        ...(page ? { page } : {}),
      });
    }

    if (Object.keys(validationErrors).length > 0) {
      console.warn(`[tiktok][${requestId}] Validation failed`, {
        fields: Object.keys(validationErrors),
      });
      return jsonError(res, 400, "Validation error", validationErrors);
    }

    payload = {
      ...(validateNonEmptyString(body.pixel_code) ? { pixel_code: body.pixel_code.trim() } : {}),
      ...(validateNonEmptyString(body.event) ? { event: body.event.trim() } : {}),
      event_source: body.event_source.trim(),
      event_source_id: body.event_source_id.trim(),
      test_event_code: validateNonEmptyString(body.test_event_code)
        ? body.test_event_code.trim()
        : TEST_EVENT_CODE,
      data: normalizedData,
    };
  } else {
    const phone = body.phone;
    const ttclid = body.ttclid;
    const externalId = body.external_id;

    const validationErrors = {};

    if (!validateNonEmptyString(phone)) {
      validationErrors.phone = "phone is required and must be a non-empty string";
    }

    if (!validateNonEmptyString(ttclid)) {
      validationErrors.ttclid = "ttclid is required and must be a non-empty string";
    }

    if (!validateNonEmptyString(externalId)) {
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
    try {
      phoneHashed = hashPhoneOrThrow(phone, requestId);
    } catch (e) {
      return jsonError(res, 400, "Validation error", {
        phone: "phone must be a valid phone number or a SHA256 hex hash",
      });
    }

    payload = {
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
  }

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
