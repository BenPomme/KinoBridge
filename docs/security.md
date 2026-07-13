# Security and DRM boundary

- The helper accepts only HTTPS origins derived from a selected Kino candidate or its parsed playlists.
- The loopback broker binds to `127.0.0.1`, uses random session routes, and never becomes a general-purpose proxy.
- Native messages, popup text, paths, dimensions, headers, and filenames are runtime validated.
- Processes are spawned without a shell. Signed URLs and cookies are omitted from logs and process arguments.
- Partial downloads are isolated, cancelled cleanly, validated with ffprobe, and atomically renamed.
- Passwords and persistent browser sessions are never requested or stored.
- DRM, SAMPLE-AES/FairPlay-style encryption, and inaccessible authorization terminate the operation with a clear error. No CDM or key extraction is implemented.
