# Course Schedule Viewer Notes

## Assumptions
- The PDF is generated from the same graduate class schedule table layout as `Fall 2026 Graduate Class schedule.pdf`.
- The term can be read from the PDF filename using a pattern such as `Fall 2026`.
- The exported PDF text uses embedded glyph IDs that map to normal ASCII by adding 29 to each glyph code.
- Browser-side parsing must stay dependency-free, so the app uses the built-in `DecompressionStream` API for `/FlateDecode` PDF streams instead of PDF.js.
- Course conflicts depend on day, clock-time overlap, and course period overlap. `First 7 Weeks (7-1)` and `Second 7 Weeks (7-2)` do not conflict with each other; 14-week and 11-week courses are treated as overlapping with other periods.
- Saved schedule options can live in browser `localStorage`; a static HTML page cannot write a real local folder without a backend or browser file-system permission flow.

## Expectations
- Uploading the schedule PDF should extract course meetings, group them into sections by course code and CRN, and categorize courses by Program.
- Courses with multiple sections, such as different section numbers, should appear as separate addable options.
- Suggestion search should choose one section per desired course and return up to 50 conflict-free combinations.
- A saved schedule stores selected section keys, name, notes, term, and timestamps so multiple candidate schedules can be compared and reloaded later.

## Observations
- Some long course titles wrap across lines or merge with the credit number, e.g. `Methods4`; the parser handles credits adjacent to title text.
- Some rows place instructor and program text in the timing column when the title is wide; the parser falls back to detecting known program codes at the end of the instructor field.
- Location and note text can appear in the far-right notes column, so room parsing is intentionally permissive.
