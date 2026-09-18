//! Build logging utilities.
//!
//! This module handles creation and management of build log files.

use crate::paths::foc_devnet_logs;
use std::fs;
use std::fs::File;
use std::path::{Path, PathBuf};

/// Create a timestamped log file path for build logs.
pub fn create_build_log_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let logs_dir = foc_devnet_logs().join("build");
    fs::create_dir_all(&logs_dir)?;

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let log_path = logs_dir.join(format!("{}.log", timestamp));

    Ok(log_path)
}

/// Open a build log for appending on the host.
pub fn open_build_log(log_path: &Path) -> Result<File, Box<dyn std::error::Error>> {
    Ok(fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?)
}

#[cfg(test)]
mod tests {
    use super::open_build_log;

    #[test]
    fn open_build_log_rejects_a_directory() {
        let directory = tempfile::tempdir().unwrap();

        assert!(open_build_log(directory.path()).is_err());
    }
}
