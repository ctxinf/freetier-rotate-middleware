//! Extracting token usage from a streamed response.
//!
//! The client's stream must not be delayed, so the proxy tees the upstream body
//! and feeds one copy through this parser while the other flows straight to the
//! client. Only the `usage` object is of interest; everything else is skipped.

use crate::storage::logs::Usage;

/// Incremental SSE scanner. Feed it chunks; it keeps the last `usage` it saw.
#[derive(Default)]
pub struct UsageCollector {
    buf: String,
    usage: Option<Usage>,
}

impl UsageCollector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) {
        // Upstreams may split a UTF-8 sequence across chunks; keep the tail.
        self.buf.push_str(&String::from_utf8_lossy(chunk));

        while let Some(idx) = self.buf.find('\n') {
            let line = self.buf[..idx].trim_end_matches('\r').to_string();
            self.buf.drain(..=idx);
            self.consume_line(&line);
        }
    }

    /// Flush any trailing partial line and take the collected usage.
    pub fn finish(mut self) -> Option<Usage> {
        if !self.buf.is_empty() {
            let line = std::mem::take(&mut self.buf);
            self.consume_line(line.trim_end_matches('\r'));
        }
        self.usage
    }

    fn consume_line(&mut self, line: &str) {
        let Some(payload) = line.strip_prefix("data:") else {
            return;
        };
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            return;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
            return;
        };
        if let Some(u) = parse_usage(&v) {
            // Later chunks carry the cumulative total, so the last one wins.
            self.usage = Some(u);
        }
    }
}

/// Pull usage out of a chat-completion payload, tolerating the field names the
/// common OpenAI-compatible upstreams use for cached input.
pub fn parse_usage(v: &serde_json::Value) -> Option<Usage> {
    let u = v.get("usage")?;
    if u.is_null() {
        return None;
    }

    let int = |key: &str| u.get(key).and_then(|x| x.as_i64());
    let cached = int("cached_tokens")
        .or_else(|| {
            u.get("prompt_tokens_details")
                .and_then(|d| d.get("cached_tokens"))
                .and_then(|x| x.as_i64())
        })
        .or_else(|| int("prompt_cache_hit_tokens"));

    let usage = Usage {
        prompt_tokens: int("prompt_tokens").or_else(|| int("input_tokens")),
        cached_tokens: cached,
        completion_tokens: int("completion_tokens").or_else(|| int("output_tokens")),
        total_tokens: int("total_tokens"),
    };

    if usage.prompt_tokens.is_none()
        && usage.completion_tokens.is_none()
        && usage.total_tokens.is_none()
    {
        return None;
    }
    Some(usage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_usage_from_a_final_sse_chunk() {
        let mut c = UsageCollector::new();
        c.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
        c.push(b"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\n");
        c.push(b"data: [DONE]\n\n");

        let u = c.finish().unwrap();
        assert_eq!(u.prompt_tokens, Some(10));
        assert_eq!(u.completion_tokens, Some(5));
        assert_eq!(u.total_tokens, Some(15));
    }

    #[test]
    fn handles_usage_split_across_chunk_boundaries() {
        let mut c = UsageCollector::new();
        c.push(b"data: {\"usage\":{\"prompt_to");
        c.push(b"kens\":7,\"completion_tokens\":3,\"total_tokens\":10}}\n");

        let u = c.finish().unwrap();
        assert_eq!(u.prompt_tokens, Some(7));
        assert_eq!(u.total_tokens, Some(10));
    }

    #[test]
    fn reads_cached_tokens_from_prompt_details() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,
                 "prompt_tokens_details":{"cached_tokens":80}}}"#,
        )
        .unwrap();
        let u = parse_usage(&v).unwrap();
        assert_eq!(u.cached_tokens, Some(80));
    }

    #[test]
    fn a_stream_without_usage_yields_none() {
        let mut c = UsageCollector::new();
        c.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n");
        c.push(b"data: [DONE]\n\n");
        assert!(c.finish().is_none());
    }

    #[test]
    fn malformed_json_is_skipped_not_fatal() {
        let mut c = UsageCollector::new();
        c.push(b"data: {not json\n\n");
        c.push(b"data: {\"usage\":{\"total_tokens\":42}}\n\n");
        assert_eq!(c.finish().unwrap().total_tokens, Some(42));
    }

    #[test]
    fn last_usage_wins_when_repeated() {
        let mut c = UsageCollector::new();
        c.push(b"data: {\"usage\":{\"total_tokens\":10}}\n\n");
        c.push(b"data: {\"usage\":{\"total_tokens\":99}}\n\n");
        assert_eq!(c.finish().unwrap().total_tokens, Some(99));
    }
}
