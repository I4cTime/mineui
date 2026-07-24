//! Error contract (§1 of docs/v2-contract.md).
//!
//! Every command rejects with exactly `{ "code": <ErrorCode>, "message": <string> }`.

use serde::ser::{Serialize, SerializeStruct, Serializer};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    RuntimeNotFound(String),
    #[error("{0}")]
    ContainerNotFound(String),
    #[error("{0}")]
    ServerNotRunning(String),
    #[error("{0}")]
    ServerRunning(String),
    #[error("{0}")]
    RconUnavailable(String),
    #[error("{0}")]
    RconCommandBlocked(String),
    #[error("{0}")]
    QueryUnavailable(String),
    #[error("{0}")]
    JavaNotFound(String),
    #[error("{0}")]
    JavaIncompatible(String),
    #[error("{0}")]
    EulaNotAccepted(String),
    #[error("{0}")]
    InstanceNotFound(String),
    #[error("{0}")]
    InstanceExists(String),
    #[error("{0}")]
    DownloadFailed(String),
    #[error("{0}")]
    ChecksumMismatch(String),
    #[error("{0}")]
    ServerUtilsUnavailable(String),
    #[error("{0}")]
    PathNotAllowed(String),
    #[error("{0}")]
    FileTooLarge(String),
    #[error("{0}")]
    WrongMode(String),
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    SettingsInvalid(String),
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Internal(String),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::RuntimeNotFound(_) => "RUNTIME_NOT_FOUND",
            Error::ContainerNotFound(_) => "CONTAINER_NOT_FOUND",
            Error::ServerNotRunning(_) => "SERVER_NOT_RUNNING",
            Error::ServerRunning(_) => "SERVER_RUNNING",
            Error::RconUnavailable(_) => "RCON_UNAVAILABLE",
            Error::RconCommandBlocked(_) => "RCON_COMMAND_BLOCKED",
            Error::QueryUnavailable(_) => "QUERY_UNAVAILABLE",
            Error::JavaNotFound(_) => "JAVA_NOT_FOUND",
            Error::JavaIncompatible(_) => "JAVA_INCOMPATIBLE",
            Error::EulaNotAccepted(_) => "EULA_NOT_ACCEPTED",
            Error::InstanceNotFound(_) => "INSTANCE_NOT_FOUND",
            Error::InstanceExists(_) => "INSTANCE_EXISTS",
            Error::DownloadFailed(_) => "DOWNLOAD_FAILED",
            Error::ChecksumMismatch(_) => "CHECKSUM_MISMATCH",
            Error::ServerUtilsUnavailable(_) => "SERVER_UTILS_UNAVAILABLE",
            Error::PathNotAllowed(_) => "PATH_NOT_ALLOWED",
            Error::FileTooLarge(_) => "FILE_TOO_LARGE",
            Error::WrongMode(_) => "WRONG_MODE",
            Error::InvalidInput(_) => "INVALID_INPUT",
            Error::SettingsInvalid(_) => "SETTINGS_INVALID",
            Error::Io(_) => "IO",
            Error::Internal(_) => "INTERNAL",
        }
    }
}

/// Serializes to exactly `{ "code": "...", "message": "..." }` (§1).
impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut s = serializer.serialize_struct("Error", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_code_message_shape() {
        let e = Error::RconCommandBlocked("command not allowed".into());
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "code": "RCON_COMMAND_BLOCKED", "message": "command not allowed" })
        );
    }

    #[test]
    fn io_error_maps_to_io_code() {
        let e: Error = std::io::Error::new(std::io::ErrorKind::NotFound, "nope").into();
        assert_eq!(e.code(), "IO");
    }
}
