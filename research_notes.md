# Course Schedule Viewer Notes

## Assumptions
- The PDF is generated from the same graduate class schedule table layout as `Fall 2026 Graduate Class schedule.pdf`.
- The term can be read from the PDF filename using a pattern such as `Fall 2026`.
- The exported PDF text uses embedded glyph IDs that map to normal ASCII by adding 29 to each glyph code.
- Browser-side parsing must stay dependency-free, so the app uses the built-in `DecompressionStream` API for `/FlateDecode` PDF streams instead of PDF.js.
- Course conflicts depend on day, clock-time overlap, and course period overlap. `First 7 Weeks (7-1)` and `Second 7 Weeks (7-2)` do not conflict with each other; 14-week and 11-week courses are treated as overlapping with other periods.
- Saved schedule options can live in browser `localStorage`; a static HTML page cannot write a real local folder without a backend or browser file-system permission flow.


## Spring 2027 timetable layout (parser v3)
- The Spring 2027 PDF ("Graduate Class Timetable") uses a new table: `Course Codes/Section | CRN | Course Title | Primary Instructor | Secondary Instructor | Core/Elective | Program | Level | #of Credits | Course Period | No. of students | Course Capacity | Day | Timings | New Classroom code | Old Classroom Code | Notes`.
- Each row is one meeting. Codes look like `ML7501-lec-001` / `ML7501-lab-001`; they are normalized to `ML7501-001` + type `Lecture`/`Lab` so lecture and lab rows sharing a CRN form one section.
- Text uses Type0/Identity-H fonts with a ToUnicode CMap (the old glyph+29 trick no longer applies), so the app now has a small generic content-stream interpreter (Tf/Tm/Td/TJ/Tj, CID widths) that yields positioned text items.
- Column edges come from the header row on each page; wrapped cells (titles, instructors, period + date range) are joined by attaching every item to the nearest row anchor by y.
- An overflowing title can share a text run with the next cell (e.g. ML8507 + "Maxim Panov"); runs are split at kerning gaps that cross a column edge.
- Course periods are normalized to `14 weeks`, `First 7 weeks`, `Second 7 weeks`, `11 weeks` (and `First + Second 7 weeks` for CBIO7105). Rows with `N/A` days/times become a section with a "time TBA" meeting that never conflicts.
- Level comes from the Level column when present (`MS/PhD` matches both filters); otherwise it falls back to the 7xx/8xx course number.
- Room shows the new classroom code with the old code alongside, e.g. `A002 (old CR4)`.
- `data/spring-2027.js` ships the parsed Spring 2027 meetings so the site opens with that term; a PDF loaded by the user (parsed with the current parser version) takes priority. The legacy Fall 2026 parser is kept as a fallback for old PDFs.
- Known source-data quirks left as printed: some lab rows list 4 credits (sections use the max credit value of their meetings); CBIO7301 and CBIO7310 share CRN 10009.

## Expectations
- Uploading the schedule PDF should extract course meetings, group them into sections by course code and CRN, and categorize courses by Program.
- Courses with multiple sections, such as different section numbers, should appear as separate addable options.
- Suggestion search should choose one section per desired course and return up to 50 conflict-free combinations.
- A saved schedule stores selected section keys, name, notes, term, and timestamps so multiple candidate schedules can be compared and reloaded later.

## Observations
- Some long course titles wrap across lines or merge with the credit number, e.g. `Methods4`; the parser handles credits adjacent to title text.
- Some rows place instructor and program text in the timing column when the title is wide; the parser falls back to detecting known program codes at the end of the instructor field.
- Location and note text can appear in the far-right notes column, so room parsing is intentionally permissive.
