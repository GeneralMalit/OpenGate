import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, errors, jwtVerify } from "jose";
const verifierCache = new WeakMap();
export function getJwtVerifier(config) {
    const existing = verifierCache.get(config);
    if (existing) {
        return existing;
    }
    const created = createJwtVerifier(config);
    verifierCache.set(config, created);
    return created;
}
function createJwtVerifier(config) {
    const jwksCache = new Map();
    return {
        verify: async (token) => {
            const decodedPayload = safelyDecodePayload(token);
            if (!decodedPayload) {
                return fail(401, "unauthorized", "invalid_jwt");
            }
            const tokenIssuer = typeof decodedPayload.iss === "string" ? decodedPayload.iss : null;
            const issuerCandidates = tokenIssuer
                ? config.jwt.issuers.filter((issuer) => issuer.issuer === tokenIssuer)
                : config.jwt.issuers;
            const enabledCandidates = issuerCandidates.filter((issuer) => issuer.enabled !== false);
            if (issuerCandidates.length > 0 && enabledCandidates.length === 0) {
                return fail(403, "forbidden", "issuer_disabled");
            }
            const candidates = enabledCandidates.length > 0
                ? enabledCandidates
                : config.jwt.issuers.filter((issuer) => issuer.enabled !== false);
            for (const issuerConfig of candidates) {
                const result = issuerConfig.verificationMode === "jwks"
                    ? await verifyWithJwks(issuerConfig, token, jwksCache)
                    : await verifyWithSharedSecret(issuerConfig, token);
                if (result.ok) {
                    return {
                        ok: true,
                        payload: result.payload,
                        issuerConfig
                    };
                }
            }
            return fail(401, "unauthorized", "invalid_jwt");
        }
    };
}
async function verifyWithSharedSecret(issuerConfig, token) {
    if (issuerConfig.verificationMode === "jwks") {
        return fail(401, "unauthorized", "invalid_jwt");
    }
    try {
        const verification = await jwtVerify(token, new TextEncoder().encode(issuerConfig.sharedSecret), {
            issuer: issuerConfig.issuer,
            audience: issuerConfig.audiences
        });
        return {
            ok: true,
            payload: verification.payload
        };
    }
    catch {
        return fail(401, "unauthorized", "invalid_jwt");
    }
}
async function verifyWithJwks(issuerConfig, token, jwksCache) {
    const header = safelyDecodeHeader(token);
    if (!header) {
        return fail(401, "unauthorized", "invalid_jwt");
    }
    if (!header.kid) {
        return fail(401, "unauthorized", "missing_kid");
    }
    if (!header.alg || !issuerConfig.allowedAlgorithms.includes(header.alg)) {
        return fail(401, "unauthorized", "invalid_alg");
    }
    const initialVerifier = await getJwksVerifier(issuerConfig, jwksCache, false);
    const firstAttempt = await verifyWithLocalJwks(initialVerifier, issuerConfig, token);
    if (firstAttempt.ok) {
        return firstAttempt;
    }
    if (firstAttempt.blockReason !== "unknown_signing_key") {
        return firstAttempt;
    }
    const refreshedVerifier = await getJwksVerifier(issuerConfig, jwksCache, true);
    return verifyWithLocalJwks(refreshedVerifier, issuerConfig, token);
}
async function verifyWithLocalJwks(verifier, issuerConfig, token) {
    try {
        const verification = await jwtVerify(token, verifier, {
            issuer: issuerConfig.issuer,
            audience: issuerConfig.audiences,
            algorithms: issuerConfig.allowedAlgorithms
        });
        return {
            ok: true,
            payload: verification.payload
        };
    }
    catch (error) {
        if (error instanceof errors.JWKSNoMatchingKey) {
            return fail(401, "unauthorized", "unknown_signing_key");
        }
        return fail(401, "unauthorized", "invalid_jwt");
    }
}
async function getJwksVerifier(issuerConfig, jwksCache, forceRefresh) {
    const cacheKey = `${issuerConfig.issuer}:${issuerConfig.jwksUrl}`;
    const now = Date.now();
    const ttl = issuerConfig.cacheTtlMs ?? 300_000;
    const cached = jwksCache.get(cacheKey);
    if (!forceRefresh && cached && now - cached.fetchedAt < ttl) {
        return cached.verifier;
    }
    const jwks = await fetchJwks(issuerConfig);
    const verifier = createLocalJWKSet(jwks);
    jwksCache.set(cacheKey, {
        fetchedAt: now,
        verifier
    });
    return verifier;
}
async function fetchJwks(issuerConfig) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), issuerConfig.requestTimeoutMs ?? 5_000);
    try {
        const response = await fetch(issuerConfig.jwksUrl, {
            headers: {
                accept: "application/json"
            },
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`JWKS fetch failed with status ${response.status}`);
        }
        const json = await response.json();
        if (!Array.isArray(json.keys)) {
            throw new Error("JWKS response did not contain a keys array.");
        }
        return {
            keys: json.keys
        };
    }
    finally {
        clearTimeout(timeout);
    }
}
function safelyDecodePayload(token) {
    try {
        return decodeJwt(token);
    }
    catch {
        return null;
    }
}
function safelyDecodeHeader(token) {
    try {
        return decodeProtectedHeader(token);
    }
    catch {
        return null;
    }
}
function fail(statusCode, message, blockReason) {
    return {
        ok: false,
        statusCode,
        message,
        blockReason
    };
}
