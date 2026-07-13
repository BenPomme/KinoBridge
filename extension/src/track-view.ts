import type { MediaTrack } from "@kinobridge/shared";
import type { TrackView } from "./messages.js";

export function projectTrack(track: MediaTrack): TrackView {
  return {
    id: track.id,
    type: track.type,
    ...(track.name ? { name: track.name } : {}),
    ...(track.language ? { language: track.language } : {}),
    default: track.default,
    autoselect: track.autoselect,
    forced: track.forced
  };
}
