use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
pub const ARCHIVE_COUNT: usize = 3;
pub const MAX_LINE_BYTES: usize = 16 * 1024;

fn archive_path(path: &Path, index: usize) -> PathBuf {
    path.with_file_name(format!("talkis.{index}.log"))
}

pub fn bounded_line(mut line: String) -> String {
    if line.len() > MAX_LINE_BYTES {
        const SUFFIX: &str = "… [truncated]\n";
        let mut boundary = MAX_LINE_BYTES - SUFFIX.len();
        while !line.is_char_boundary(boundary) {
            boundary -= 1;
        }
        line.truncate(boundary);
        line.push_str(SUFFIX);
    }

    line
}

fn rotate(path: &Path, limit: u64) -> std::io::Result<()> {
    for index in (2..=ARCHIVE_COUNT).rev() {
        let previous = archive_path(path, index - 1);
        if previous.exists() {
            fs::copy(previous, archive_path(path, index))?;
        }
    }

    let mut current = OpenOptions::new().read(true).write(true).open(path)?;
    let length = current.metadata()?.len();
    let offset = length.saturating_sub(limit);
    current.seek(SeekFrom::Start(offset))?;
    let mut tail = Vec::with_capacity(length.min(limit) as usize);
    Read::by_ref(&mut current)
        .take(limit)
        .read_to_end(&mut tail)?;
    if offset > 0 {
        if let Some(newline) = tail.iter().position(|byte| *byte == b'\n') {
            tail.drain(..=newline);
        }
    }
    fs::write(archive_path(path, 1), tail)?;
    // Preserve the file identity used by the pre-opened emergency crash handle.
    current.set_len(0)
}

pub fn append(path: &Path, line: &[u8], limit: u64) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let length = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if length > 0 && length.saturating_add(line.len() as u64) > limit {
        rotate(path, limit)?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_current_log_and_archives_and_keeps_newest_records() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("talkis.log");
        for index in 0..20 {
            append(&path, format!("record-{index:02}\n").as_bytes(), 20).unwrap();
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), "record-18\nrecord-19\n");
        assert_eq!(
            fs::read_to_string(archive_path(&path, 1)).unwrap(),
            "record-16\nrecord-17\n"
        );
        assert!(!archive_path(&path, 4).exists());
        for index in 1..=ARCHIVE_COUNT {
            assert!(fs::metadata(archive_path(&path, index)).unwrap().len() <= 20);
        }
    }

    #[test]
    fn rotation_preserves_preopened_crash_handle_on_current_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("talkis.log");
        append(&path, b"before\n", 10).unwrap();
        let mut emergency = OpenOptions::new().append(true).open(&path).unwrap();
        append(&path, b"after\n", 10).unwrap();
        emergency.write_all(b"crash\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "after\ncrash\n");
        assert_eq!(
            fs::read_to_string(archive_path(&path, 1)).unwrap(),
            "before\n"
        );
    }

    #[test]
    fn handles_an_existing_oversized_log_without_unbounded_archives() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("talkis.log");
        fs::write(&path, b"old old old\nlatest\n").unwrap();
        append(&path, b"new\n", 10).unwrap();
        assert!(fs::metadata(archive_path(&path, 1)).unwrap().len() <= 10);
        assert!(fs::read_to_string(archive_path(&path, 1))
            .unwrap()
            .ends_with("latest\n"));
    }

    #[test]
    fn truncates_long_unicode_messages_at_a_character_boundary() {
        let line = bounded_line("я".repeat(MAX_LINE_BYTES));
        assert!(line.len() <= MAX_LINE_BYTES);
        assert!(line.ends_with("[truncated]\n"));
    }
}
