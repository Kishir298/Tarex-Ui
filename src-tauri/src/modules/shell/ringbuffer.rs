use std::collections::VecDeque;

/// Byte-oriented bounded ring buffer with monotonic offsets.
///
/// Callers tail the buffer using `since_offset`: each `push` advances
/// `next_offset` by the number of bytes appended, even when older bytes are
/// dropped to fit the cap. `read_from(since)` returns the slice of bytes from
/// the requested offset (clamped to whatever is still resident) plus the new
/// offset for the next call.
pub struct BoundedRingBuffer {
    buf: VecDeque<u8>,
    cap: usize,
    next_offset: u64,
    /// Bytes that were dropped to keep the buffer ≤ cap. Helps the caller
    /// detect overflow ("you missed N bytes").
    dropped: u64,
}

impl BoundedRingBuffer {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap.min(64 * 1024)),
            cap,
            next_offset: 0,
            dropped: 0,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        self.next_offset = self.next_offset.saturating_add(data.len() as u64);
        if data.len() >= self.cap {
            // Incoming chunk alone exceeds cap: keep only its tail.
            let keep_from = data.len() - self.cap;
            self.dropped = self
                .dropped
                .saturating_add((self.buf.len() + keep_from) as u64);
            self.buf.clear();
            self.buf.extend(&data[keep_from..]);
            return;
        }
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        if overflow > 0 {
            for _ in 0..overflow {
                self.buf.pop_front();
            }
            self.dropped = self.dropped.saturating_add(overflow as u64);
        }
        self.buf.extend(data);
    }

    pub fn read_from(&self, since: u64) -> (Vec<u8>, u64, u64) {
        let oldest = self.next_offset.saturating_sub(self.buf.len() as u64);
        let start = since.max(oldest);
        let skip = (start - oldest) as usize;
        let (front, back) = self.buf.as_slices();
        let mut out = Vec::with_capacity(self.buf.len().saturating_sub(skip));
        if skip < front.len() {
            out.extend_from_slice(&front[skip..]);
            out.extend_from_slice(back);
        } else {
            let back_skip = skip - front.len();
            if back_skip < back.len() {
                out.extend_from_slice(&back[back_skip..]);
            }
        }
        (out, self.next_offset, self.dropped)
    }

    pub fn read_tail_from(&self, since: u64, max_bytes: usize) -> (Vec<u8>, u64, u64) {
        let tail_start = self.next_offset.saturating_sub(max_bytes as u64);
        self.read_from(since.max(tail_start))
    }
}

#[cfg(test)]
mod tests {
    use super::BoundedRingBuffer;

    #[test]
    fn read_from_returns_all_when_within_cap() {
        let mut buf = BoundedRingBuffer::new(16);
        buf.push(b"hello world");
        let (bytes, off, dropped) = buf.read_from(0);
        assert_eq!(bytes, b"hello world");
        assert_eq!(off, 11);
        assert_eq!(dropped, 0);
    }

    #[test]
    fn read_from_skips_consumed_prefix() {
        let mut buf = BoundedRingBuffer::new(16);
        buf.push(b"hello world");
        let (bytes, off, _) = buf.read_from(6);
        assert_eq!(bytes, b"world");
        assert_eq!(off, 11);
    }

    #[test]
    fn read_from_handles_wraparound() {
        let mut buf = BoundedRingBuffer::new(8);
        buf.push(b"abcdefgh");
        buf.push(b"ijkl");
        let (bytes, off, dropped) = buf.read_from(0);
        assert_eq!(bytes, b"efghijkl");
        assert_eq!(off, 12);
        assert_eq!(dropped, 4);
    }

    #[test]
    fn read_from_clamps_to_oldest() {
        let mut buf = BoundedRingBuffer::new(8);
        buf.push(b"abcdefgh");
        buf.push(b"ijkl");
        let (bytes, _, _) = buf.read_from(0);
        let (bytes2, _, _) = buf.read_from(99);
        assert_eq!(bytes, b"efghijkl");
        assert!(bytes2.is_empty());
    }

    #[test]
    fn push_larger_than_cap_keeps_tail() {
        let mut buf = BoundedRingBuffer::new(4);
        buf.push(b"abcdefgh");
        let (bytes, off, dropped) = buf.read_from(0);
        assert_eq!(bytes, b"efgh");
        assert_eq!(off, 8);
        assert_eq!(dropped, 4);
    }

    #[test]
    fn bounded_tail_preserves_absolute_offsets_and_ring_drop_count() {
        let mut buf = BoundedRingBuffer::new(8);
        buf.push(b"abcdef");
        buf.push(b"ghijkl");
        assert_eq!(buf.read_tail_from(0, 3), (b"jkl".to_vec(), 12, 4));
        assert_eq!(buf.read_tail_from(11, 3), (b"l".to_vec(), 12, 4));
        assert_eq!(buf.read_tail_from(12, 3), (vec![], 12, 4));
        buf.push(b"mn");
        assert_eq!(buf.read_tail_from(12, 3), (b"mn".to_vec(), 14, 6));
        assert_eq!(buf.read_tail_from(0, 0), (vec![], 14, 6));
        assert_eq!(buf.read_tail_from(u64::MAX, 3), (vec![], 14, 6));
    }

    #[test]
    fn bounded_tail_never_copies_the_full_large_ring() {
        let mut buf = BoundedRingBuffer::new(4 * 1024 * 1024);
        buf.push(&vec![b'a'; 4 * 1024 * 1024]);
        buf.push(b"last line\n");
        let (bytes, offset, dropped) = buf.read_tail_from(0, 64 * 1024);
        assert_eq!(bytes.len(), 64 * 1024);
        assert!(bytes.ends_with(b"last line\n"));
        assert_eq!(offset, 4 * 1024 * 1024 + 10);
        assert_eq!(dropped, 10);
    }
}
