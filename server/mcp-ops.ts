import type { OP_NAMES } from '../shared/ops';
/** The MCP tool that performs each op (apply_ops runs any of them too). Checked against OP_NAMES by the tests. */
export const OP_TOOLS: Record<(typeof OP_NAMES)[number], string> = {
  cut_range: 'cut_range', split: 'split', delete: 'delete', add_text: 'add_text', add_transition: 'add_transition', add_music: 'add_music',
  set_aspect: 'set_aspect', add_clip: 'add_clip', move_clip: 'move_clip', trim_clip: 'trim_clip', update_clip: 'update_clip',
  set_animation: 'set_animation', set_settings: 'set_settings', set_caption_style: 'set_caption_style', add_track: 'add_track',
  delete_track: 'delete_track', set_in_out: 'set_in_out', set_captions: 'set_captions', remove_media: 'remove_media', set_fx: 'set_effect',
  set_speed: 'set_speed', duplicate: 'duplicate_clip', detach_audio: 'detach_audio', set_track: 'set_track',
  set_caption_animation: 'set_caption_animation', ripple_delete: 'ripple_delete', set_keyframe: 'set_keyframe', delete_keyframe: 'delete_keyframe',
  clear_keyframes: 'delete_keyframe', punch_in: 'punch_in', insert_clip: 'insert_clip', move_clip_to_new_track: 'move_clip_to_new_track',
  set_layout: 'set_layout', set_logo: 'set_logo', set_title_font: 'set_title_font',
};
