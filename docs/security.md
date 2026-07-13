# Security and DRM boundary

- The helper accepts only HTTPS origins derived from a selected Kino candidate or its parsed playlists.
- The loopback broker binds to `127.0.0.1`, uses random session routes, and never becomes a general-purpose proxy.
- Native messages, companion-window text, paths, dimensions, headers, and filenames are runtime validated.
- Processes are spawned without a shell. Signed URLs and cookies are omitted from logs and process arguments.
- Partial downloads are isolated, cancelled cleanly, validated with ffprobe, and atomically renamed.
- The persistent offline state never contains HLS URLs, cookies, authorization headers, or bearer tokens. Running/queued jobs become interrupted after restart and require a fresh authorized capture.
- Library deletion accepts only the ID of an existing record and deletes only its exact registered regular `.mkv` or `.mp4` file after user confirmation.
- Passwords and persistent browser sessions are never requested or stored.
- DRM, SAMPLE-AES/FairPlay-style encryption, and inaccessible authorization terminate the operation with a clear error. No CDM or key extraction is implemented.
