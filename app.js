const state = {
  term: "",
  meetings: [],
  courses: [],
  sections: new Map(),
  selectedSections: new Set(),
  desiredCourses: new Set(),
  mustCourses: new Set(),
  hiddenSuggestionCourses: new Set(),
  suggestionHistory: [],
  savedSchedules: [],
  schedulePeriod: "all",
  conflicts: [],
};

const PROGRAMS = ["ML", "CV", "NLP", "CS", "ROB", "SDS", "HCI", "CBIO", "All PhD", "All"];
const PERIODS = [
  "14 weeks",
  "First 7 Weeks (7-1)",
  "Second 7 Weeks (7-2)",
  "11 weeks",
];
const DAYS = [
  ["M", "Monday"],
  ["T", "Tuesday"],
  ["W", "Wednesday"],
  ["R", "Thursday"],
  ["F", "Friday"],
  ["U", "Sunday"],
];
const START_HOUR = 8;
const END_HOUR = 19;
const HOUR_HEIGHT = 64;
const MIN_DAY_WIDTH = 150;
const TIME_WIDTH = 70;
const PARSER_VERSION = 2;
const LAST_LOADED_JSON_KEY = "courseScheduleViewer.lastLoadedJson";
const SAVED_SCHEDULES_KEY = "courseScheduleViewer.savedSchedules";
const SUGGESTION_HISTORY_KEY = "courseScheduleViewer.suggestionHistory";

const els = {
  pdfInput: document.getElementById("pdfInput"),
  termLabel: document.getElementById("termLabel"),
  searchInput: document.getElementById("searchInput"),
  programFilter: document.getElementById("programFilter"),
  levelFilter: document.getElementById("levelFilter"),
  stats: document.getElementById("stats"),
  catalog: document.getElementById("catalog"),
  selectedSummary: document.getElementById("selectedSummary"),
  selectedCourses: document.getElementById("selectedCourses"),
  scheduleGrid: document.getElementById("scheduleGrid"),
  periodButtons: document.querySelectorAll("[data-period-view]"),
  copyCrns: document.getElementById("copyCrns"),
  openSaveSchedule: document.getElementById("openSaveSchedule"),
  saveScheduleForm: document.getElementById("saveScheduleForm"),
  scheduleName: document.getElementById("scheduleName"),
  scheduleNotes: document.getElementById("scheduleNotes"),
  savedCount: document.getElementById("savedCount"),
  savedSchedules: document.getElementById("savedSchedules"),
  conflictList: document.getElementById("conflictList"),
  desiredList: document.getElementById("desiredList"),
  suggestions: document.getElementById("suggestions"),
  suggestionHistory: document.getElementById("suggestionHistory"),
  clearSuggestionHistory: document.getElementById("clearSuggestionHistory"),
  clearSelection: document.getElementById("clearSelection"),
  suggestButton: document.getElementById("suggestButton"),
  downloadJson: document.getElementById("downloadJson"),
  dataOutput: document.getElementById("dataOutput"),
  status: document.getElementById("status"),
};

els.pdfInput.addEventListener("change", handlePdfUpload);
els.searchInput.addEventListener("input", renderCatalog);
els.programFilter.addEventListener("change", renderCatalog);
els.levelFilter.addEventListener("change", renderCatalog);
els.clearSelection.addEventListener("click", () => {
  state.selectedSections.clear();
  renderAll();
});
els.suggestButton.addEventListener("click", renderSuggestions);
els.clearSuggestionHistory.addEventListener("click", () => {
  state.suggestionHistory = [];
  persistSuggestionHistory();
  renderSuggestionHistory();
});
els.downloadJson.addEventListener("click", downloadJson);
els.copyCrns.addEventListener("click", copySelectedCrns);
els.openSaveSchedule.addEventListener("click", () => {
  if (!els.scheduleName.value.trim()) {
    els.scheduleName.value = defaultScheduleName();
  }
  setView("saved");
  els.scheduleName.focus();
});
els.saveScheduleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveCurrentSchedule();
});
els.periodButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.schedulePeriod = button.dataset.periodView;
    renderSchedule();
    renderSelectedCourses();
  });
});
window.addEventListener("resize", () => {
  window.clearTimeout(renderSchedule.resizeTimer);
  renderSchedule.resizeTimer = window.setTimeout(() => {
    renderSchedule();
    renderSelectedCourses();
  }, 120);
});

state.savedSchedules = loadSavedScheduleFolder();
state.suggestionHistory = loadSuggestionHistory();

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setView(tab.dataset.view));
});

async function handlePdfUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    showStatus("Reading PDF...");
    const buffer = await file.arrayBuffer();
    const items = await extractPdfTextItems(buffer);
    const meetings = parseMeetings(items, file.name);

    if (!meetings.length) {
      throw new Error("No course rows were found. This parser expects the graduate class schedule table format.");
    }

    state.term = termFromFileName(file.name);
    state.meetings = meetings;
    buildCourseIndex();
    saveLastLoadedJson(file.name);
    renderAll();
    showStatus(`Loaded ${state.meetings.length} meetings from ${file.name}.`);
  } catch (error) {
    console.error(error);
    showStatus(error.message || "Could not parse the PDF.");
  }
}

async function extractPdfTextItems(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const raw = new TextDecoder("latin1").decode(bytes);
  const streamRegex = /stream\r?\n/g;
  const items = [];
  let match;
  let streamIndex = 0;

  while ((match = streamRegex.exec(raw))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end === -1) break;

    const dictionary = raw.slice(Math.max(0, match.index - 500), match.index);
    let streamBytes = bytes.slice(start, end);
    streamBytes = trimStreamBytes(streamBytes);

    let decodedBytes = streamBytes;
    if (dictionary.includes("/FlateDecode")) {
      decodedBytes = await inflateBytes(streamBytes);
    }

    const content = new TextDecoder("latin1").decode(decodedBytes);
    extractItemsFromContent(content, streamIndex, items);
    streamIndex += 1;
    streamRegex.lastIndex = end + "endstream".length;
  }

  return items;
}

function trimStreamBytes(bytes) {
  let start = 0;
  let end = bytes.length;
  while (start < end && (bytes[start] === 10 || bytes[start] === 13)) start += 1;
  while (end > start && (bytes[end - 1] === 10 || bytes[end - 1] === 13)) end -= 1;
  return bytes.slice(start, end);
}

async function inflateBytes(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress PDF streams. Use a current Chromium, Edge, or Safari browser.");
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function extractItemsFromContent(content, streamIndex, items) {
  const textRegex = /1 0 0(?:\.0+)? -1 ([\d.]+) ([\d.]+) Tm\s*\[(.*?)\]\s*TJ/gs;
  let match;
  let order = 0;

  while ((match = textRegex.exec(content))) {
    const text = decodeTextArray(match[3]).trim();
    if (!text) continue;
    items.push({
      x: Number(match[1]),
      y: Number(match[2]),
      text,
      streamIndex,
      order,
    });
    order += 1;
  }
}

function decodeTextArray(textArray) {
  const tokenRegex = /<([0-9a-fA-F]+)>|(-?\d+(?:\.\d+)?)/g;
  let text = "";
  let match;

  while ((match = tokenRegex.exec(textArray))) {
    if (match[1]) {
      const hex = match[1];
      for (let i = 0; i < hex.length; i += 4) {
        const glyph = parseInt(hex.slice(i, i + 4), 16);
        const codePoint = glyph + 29;
        if (codePoint >= 32 && codePoint <= 126) {
          text += String.fromCharCode(codePoint);
        } else if (codePoint === 160) {
          text += " ";
        }
      }
    } else if (Number(match[2]) < -700) {
      text += " ";
    }
  }

  return cleanText(text);
}

function parseMeetings(items, fileName) {
  const sorted = [...items].sort((a, b) => {
    if (a.streamIndex !== b.streamIndex) return a.streamIndex - b.streamIndex;
    return a.order - b.order;
  });
  const starts = sorted
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isRowStart(item));
  const meetings = [];

  starts.forEach((start, position) => {
    const end = starts[position + 1] ? starts[position + 1].index : sorted.length;
    const segment = sorted.slice(start.index, end);
    const meeting = parseSegment(segment, fileName);
    if (meeting) meetings.push(meeting);
  });

  return meetings;
}

function isRowStart(item) {
  return item.x < 90 && /^[A-Z]+\d+[A-Z]*-\d{3}(?:\s+(Lecture|Lab)\s+\d{5})?/.test(item.text);
}

function parseSegment(segment, fileName) {
  const usableSegment = [];
  for (const item of segment) {
    if (usableSegment.length && isFooterItem(item)) break;
    usableSegment.push(item);
  }

  const first = usableSegment[0];
  const fullStartMatch = first.text.match(/^([A-Z]+\d+[A-Z]*-\d{3})\s+(Lecture|Lab)\s+(\d{5})(?:\s+(.*))?$/);
  const codeOnlyMatch = first.text.match(/^([A-Z]+\d+[A-Z]*-\d{3})$/);
  const consumed = new Set([first]);
  let courseCode;
  let type;
  let crn;
  let startTail = "";

  if (fullStartMatch) {
    [, courseCode, type, crn, startTail = ""] = fullStartMatch;
  } else if (codeOnlyMatch) {
    courseCode = codeOnlyMatch[1];
    const typeItem = usableSegment.find((item) => item.x >= 90 && item.x < 160 && /^(Lecture|Lab)$/.test(item.text));
    const crnItem = usableSegment.find((item) => item.x >= 150 && item.x < 260 && /^\d{5}(?:\s+.*)?$/.test(item.text));
    if (!typeItem || !crnItem) return null;
    type = typeItem.text;
    const crnMatch = crnItem.text.match(/^(\d{5})(?:\s+(.*))?$/);
    crn = crnMatch[1];
    startTail = crnMatch[2] || "";
    consumed.add(typeItem);
    consumed.add(crnItem);
  } else {
    return null;
  }

  const lowParts = [startTail];
  const instructorParts = [];
  const programParts = [];
  const periodParts = [];
  const rightParts = [];

  usableSegment.slice(1).forEach((item) => {
    if (consumed.has(item)) return;
    if (item.text.startsWith("Course Codes") || item.text.startsWith("Fall ")) return;
    if (item.x < 470) lowParts.push(item.text);
    else if (item.x < 690) instructorParts.push(item.text);
    else if (item.x < 735) programParts.push(item.text);
    else if (item.x < 880) periodParts.push(item.text);
    else rightParts.push(item.text);
  });

  const lowText = cleanText(lowParts.join(" "));
  const scheduleMatch = lowText.match(/^(.*?)(-?\d+)\s*([MTWRFU]+)\s+(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})(?:\s+(.*))?$/);
  if (!scheduleMatch) return null;

  let [, title, credits, days, time, trailingInstructor = ""] = scheduleMatch;
  title = cleanText(title.replace(/\s+-\s+lab$/i, " - lab"));

  let program = cleanText(programParts.join(" "));
  let instructor = cleanText([...instructorParts, trailingInstructor].join(" "));

  if (!program) {
    const detected = extractProgramFromEnd(instructor);
    program = detected.program;
    instructor = detected.before;
  }

  const periodInfo = parsePeriodParts(periodParts);
  const rightInfo = parseRightParts(rightParts);
  const [startTime, endTime] = normalizeTimeRange(time);

  return {
    id: `${courseCode}|${crn}|${type}|${days}|${startTime}|${endTime}`,
    term: termFromFileName(fileName),
    baseCode: courseCode.split("-")[0],
    courseCode,
    type,
    crn,
    title,
    credits: Number(credits),
    days,
    dayList: expandDays(days),
    startTime,
    endTime,
    startMinutes: minutesFromTime(startTime),
    endMinutes: minutesFromTime(endTime),
    instructor: instructor || "TBA",
    program: program || "Unknown",
    period: periodInfo.period,
    dateRange: periodInfo.dateRange,
    enrollment: rightInfo.enrollment,
    room: rightInfo.room,
    notes: cleanText([periodInfo.notes, rightInfo.notes].filter(Boolean).join(" ")),
  };
}

function isFooterItem(item) {
  return /^(Days of the week|Rooms:|Course periods)\b/.test(item.text);
}

function extractProgramFromEnd(text) {
  const sortedPrograms = [...PROGRAMS].sort((a, b) => b.length - a.length);
  for (const program of sortedPrograms) {
    const suffix = new RegExp(`\\s+${escapeRegex(program)}$`);
    if (suffix.test(text)) {
      return {
        program,
        before: cleanText(text.replace(suffix, "")),
      };
    }
  }
  return { program: "", before: text };
}

function parsePeriodParts(parts) {
  const text = cleanText(parts.join(" "));
  const period = PERIODS.find((candidate) => text.includes(candidate)) || "Unknown";
  const dateMatch = text.match(/\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+-\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+(?:\s+\d{4})?/);
  const dateRange = dateMatch ? dateMatch[0] : "";
  const notes = cleanText(text.replace(period, "").replace(dateRange, ""));
  return { period, dateRange, notes };
}

function parseRightParts(parts) {
  const text = cleanText(parts.join(" "));
  const match = text.match(/^(\d+)\s+(.+)$/);
  if (!match) return { enrollment: "", room: text, notes: "" };

  const enrollment = match[1];
  const roomAndNotes = match[2];
  const roomMatch = roomAndNotes.match(/^(TBA|(?:Lab|LH|CR)\s*\d+|Lab\d+|1[A-B]-B201)(?:\s+(.*))?$/i);
  return {
    enrollment,
    room: roomMatch ? cleanText(roomMatch[1]) : roomAndNotes,
    notes: roomMatch && roomMatch[2] ? cleanText(roomMatch[2]) : "",
  };
}

function normalizeTimeRange(value) {
  const parts = value.split("-").map((part) => part.trim());
  return [normalizeTime(parts[0]), normalizeTime(parts[1])];
}

function normalizeTime(value) {
  const [hour, minute] = value.split(":").map(Number);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function minutesFromTime(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function expandDays(days) {
  return days.split("").filter((day) => DAYS.some(([code]) => code === day));
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termFromFileName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, "");
  const termMatch = base.match(/\b(Spring|Summer|Fall|Winter)\s+\d{4}\b/i);
  if (termMatch) {
    return termMatch[0].replace(/\b\w/g, (char) => char.toUpperCase());
  }
  return base.replace(/class\s+schedule/i, "").trim() || "Loaded Term";
}

function buildCourseIndex() {
  state.sections = new Map();

  state.meetings.forEach((meeting) => {
    const sectionKey = `${meeting.courseCode}|${meeting.crn}`;
    if (!state.sections.has(sectionKey)) {
      state.sections.set(sectionKey, {
        key: sectionKey,
        baseCode: meeting.baseCode,
        courseCode: meeting.courseCode,
        crn: meeting.crn,
        title: meeting.title,
        program: meeting.program,
        credits: meeting.credits,
        meetings: [],
      });
    }
    const section = state.sections.get(sectionKey);
    section.meetings.push(meeting);
    section.credits = Math.max(section.credits, meeting.credits);
  });

  const grouped = new Map();
  state.sections.forEach((section) => {
    if (!grouped.has(section.baseCode)) {
      grouped.set(section.baseCode, {
        baseCode: section.baseCode,
        title: section.title,
        program: section.program,
        sections: [],
      });
    }
    grouped.get(section.baseCode).sections.push(section);
  });

  state.courses = [...grouped.values()].sort((a, b) => a.baseCode.localeCompare(b.baseCode));
  state.selectedSections.clear();
  state.desiredCourses.clear();
  state.mustCourses.clear();
  state.hiddenSuggestionCourses.clear();
  state.conflicts = [];
  populateProgramFilter();
}

function populateProgramFilter() {
  const current = els.programFilter.value;
  const programs = [...new Set(state.courses.map((course) => course.program))].sort();
  els.programFilter.innerHTML = `<option value="all">All programs</option>`;
  programs.forEach((program) => {
    const option = document.createElement("option");
    option.value = program;
    option.textContent = program;
    els.programFilter.appendChild(option);
  });
  els.programFilter.value = programs.includes(current) ? current : "all";
}

function renderAll() {
  state.conflicts = findConflicts(getSelectedMeetings());
  els.termLabel.textContent = state.term ? `${state.term} schedule` : "Load a graduate class schedule PDF to begin.";
  renderCatalog();
  renderSelectedCourses();
  renderSchedule();
  renderConflicts();
  renderDesiredList();
  renderSuggestionHistory();
  renderSavedSchedules();
  renderData();
}

function renderCatalog() {
  const query = els.searchInput.value.toLowerCase().trim();
  const program = els.programFilter.value;
  const level = els.levelFilter.value;
  const courses = state.courses.filter((course) => {
    const matchesProgram = program === "all" || course.program === program;
    const matchesLevel = level === "all" || courseLevel(course) === level;
    const haystack = [
      course.baseCode,
      course.title,
      course.program,
      ...course.sections.flatMap((section) => section.meetings.map((meeting) => meeting.instructor)),
    ]
      .join(" ")
      .toLowerCase();
    return matchesProgram && matchesLevel && (!query || haystack.includes(query));
  });

  els.stats.textContent = state.courses.length
    ? `${state.courses.length} courses, ${state.sections.size} sections, ${state.meetings.length} meetings`
    : "No courses loaded.";
  els.catalog.classList.toggle("empty", courses.length === 0);
  els.catalog.innerHTML = courses.length ? "" : "No matching courses.";

  courses.forEach((course) => {
    const card = document.createElement("article");
    card.className = `course-card ${programClass(course.program)}`;
    const considered = state.desiredCourses.has(course.baseCode);
    const mustTake = state.mustCourses.has(course.baseCode);
    card.innerHTML = `
      <div class="course-title">
        <div>
          <h3>
            <span class="course-code">${escapeHtml(course.baseCode)}</span>
            <span class="course-name">${escapeHtml(course.title)}</span>
          </h3>
          <div class="meta">${course.sections.length} section${course.sections.length === 1 ? "" : "s"} · ${courseLevelLabel(course)}</div>
        </div>
        <div class="course-actions">
          <span class="chip">${escapeHtml(course.program)}</span>
          <div class="course-choice-row">
            <button class="option-button${considered ? " active" : ""}" data-consider-course="${course.baseCode}">Consider</button>
            <button class="must-button${mustTake ? " active" : ""}" data-must-take="${course.baseCode}">Must</button>
          </div>
        </div>
      </div>
    `;

    course.sections.forEach((section) => {
      const row = document.createElement("div");
      row.className = "section-row";
      const selected = state.selectedSections.has(section.key);
      row.innerHTML = `
        <div class="section-detail">
          <strong>${escapeHtml(section.courseCode)}</strong> CRN ${escapeHtml(section.crn)}
          <br>${section.meetings.map(formatMeetingBrief).join("<br>")}
        </div>
        <button data-section="${escapeHtml(section.key)}">${selected ? "Remove" : "Add"}</button>
      `;
      card.appendChild(row);
    });

    els.catalog.appendChild(card);
  });

  els.catalog.querySelectorAll("[data-section]").forEach((button) => {
    button.addEventListener("click", () => toggleSection(button.dataset.section));
  });
  els.catalog.querySelectorAll("[data-must-take]").forEach((button) => {
    button.addEventListener("click", () => {
      const baseCode = button.dataset.mustTake;
      if (state.mustCourses.has(baseCode)) state.mustCourses.delete(baseCode);
      else {
        state.mustCourses.add(baseCode);
        state.desiredCourses.delete(baseCode);
        state.hiddenSuggestionCourses.delete(baseCode);
      }
      renderCatalog();
      renderDesiredList();
    });
  });
  els.catalog.querySelectorAll("[data-consider-course]").forEach((button) => {
    button.addEventListener("click", () => {
      const baseCode = button.dataset.considerCourse;
      if (state.desiredCourses.has(baseCode)) state.desiredCourses.delete(baseCode);
      else {
        state.desiredCourses.add(baseCode);
        state.mustCourses.delete(baseCode);
        state.hiddenSuggestionCourses.delete(baseCode);
      }
      renderCatalog();
      renderDesiredList();
    });
  });
}

function toggleSection(sectionKey) {
  if (state.selectedSections.has(sectionKey)) {
    state.selectedSections.delete(sectionKey);
  } else {
    const section = state.sections.get(sectionKey);
    if (section) {
      getSelectedSections()
        .filter((selected) => selected.baseCode === section.baseCode)
        .forEach((selected) => state.selectedSections.delete(selected.key));
    }
    state.selectedSections.add(sectionKey);
  }
  renderAll();
}

function renderSelectedCourses() {
  const sections = getSelectedSections();
  const credits = sections.reduce((sum, section) => sum + section.credits, 0);
  const shownMeetings = getVisibleScheduleMeetings().length;
  const viewLabel = periodViewLabel(state.schedulePeriod);
  els.selectedSummary.textContent = sections.length
    ? `${sections.length} selected section${sections.length === 1 ? "" : "s"} · ${credits} credits · ${shownMeetings} shown in ${viewLabel} · ${state.conflicts.length} conflict${state.conflicts.length === 1 ? "" : "s"}`
    : "No courses added yet.";
  els.selectedCourses.innerHTML = "";

  sections.forEach((section) => {
    const card = document.createElement("article");
    card.className = `selected-card ${programClass(section.program)}`;
    card.innerHTML = `
      <div>
        <strong>${escapeHtml(section.courseCode)} ${escapeHtml(section.title)}</strong>
        <span class="meta">CRN ${escapeHtml(section.crn)} · ${section.meetings.map(formatMeetingBrief).join(" · ")}</span>
      </div>
      <div class="selected-actions">
        <button class="secondary" data-copy-crn="${escapeHtml(section.crn)}">Copy CRN</button>
        <button class="secondary" data-remove="${escapeHtml(section.key)}">Remove</button>
      </div>
    `;
    els.selectedCourses.appendChild(card);
  });

  els.selectedCourses.querySelectorAll("[data-copy-crn]").forEach((button) => {
    button.addEventListener("click", () => copyCrn(button.dataset.copyCrn));
  });
  els.selectedCourses.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => toggleSection(button.dataset.remove));
  });
}

function renderSchedule() {
  const meetings = getVisibleScheduleMeetings();
  const conflictIds = new Set(state.conflicts.flatMap((conflict) => [conflict.a.id, conflict.b.id]));
  const rows = END_HOUR - START_HOUR;
  const dayWidth = scheduleDayWidth();
  const gridWidth = TIME_WIDTH + dayWidth * DAYS.length;
  const inner = document.createElement("div");
  inner.className = "grid-inner";
  inner.style.height = `${38 + rows * HOUR_HEIGHT}px`;
  inner.style.gridTemplateColumns = `${TIME_WIDTH}px repeat(${DAYS.length}, ${dayWidth}px)`;
  inner.style.width = `${gridWidth}px`;
  inner.style.minWidth = `${gridWidth}px`;

  inner.appendChild(document.createElement("div"));
  DAYS.forEach(([, label]) => {
    const day = document.createElement("div");
    day.className = "day-label";
    day.textContent = label;
    inner.appendChild(day);
  });

  for (let hour = START_HOUR; hour < END_HOUR; hour += 1) {
    const label = document.createElement("div");
    label.className = "time-label";
    label.textContent = `${String(hour).padStart(2, "0")}:00`;
    inner.appendChild(label);
    DAYS.forEach(() => {
      const cell = document.createElement("div");
      cell.className = "grid-cell";
      inner.appendChild(cell);
    });
  }

  meetings.forEach((meeting) => {
    meeting.dayList.forEach((dayCode) => {
      const dayIndex = DAYS.findIndex(([code]) => code === dayCode);
      if (dayIndex === -1) return;
      const block = document.createElement("div");
      const duration = meeting.endMinutes - meeting.startMinutes;
      const sizeClass = duration <= 60 ? " compact" : "";
      block.className = `meeting-block ${programClass(meeting.program)}${sizeClass}${conflictIds.has(meeting.id) ? " conflict" : ""}`;
      block.style.left = `${TIME_WIDTH + dayIndex * dayWidth + 6}px`;
      block.style.top = `${38 + ((meeting.startMinutes - START_HOUR * 60) / 60) * HOUR_HEIGHT + 4}px`;
      block.style.width = `${dayWidth - 12}px`;
      block.style.height = `${Math.max(34, ((meeting.endMinutes - meeting.startMinutes) / 60) * HOUR_HEIGHT - 8)}px`;
      block.innerHTML = `
        <strong>${escapeHtml(meeting.baseCode)} ${escapeHtml(meeting.type)}</strong>
        <span class="meeting-title">${escapeHtml(meeting.title)}</span>
        <span class="meeting-meta">${escapeHtml(meeting.startTime)}-${escapeHtml(meeting.endTime)} · ${escapeHtml(meeting.room)}</span>
      `;
      inner.appendChild(block);
    });
  });

  els.scheduleGrid.innerHTML = "";
  els.scheduleGrid.appendChild(inner);
  els.periodButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.periodView === state.schedulePeriod);
  });
}

function scheduleDayWidth() {
  const availableWidth = els.scheduleGrid.clientWidth || TIME_WIDTH + MIN_DAY_WIDTH * DAYS.length;
  const availableDayWidth = Math.floor((availableWidth - TIME_WIDTH - 2) / DAYS.length);
  return Math.max(MIN_DAY_WIDTH, availableDayWidth);
}

function renderConflicts() {
  els.conflictList.innerHTML = "";
  if (!state.conflicts.length) {
    els.conflictList.textContent = getSelectedMeetings().length ? "No conflicts found." : "Add courses to check conflicts.";
    return;
  }

  state.conflicts.forEach((conflict) => {
    const card = document.createElement("article");
    card.className = "conflict-card";
    card.innerHTML = `
      <strong>${escapeHtml(conflict.day)} ${escapeHtml(conflict.time)}</strong>
      <p>${escapeHtml(conflict.a.courseCode)} ${escapeHtml(conflict.a.title)} conflicts with ${escapeHtml(conflict.b.courseCode)} ${escapeHtml(conflict.b.title)}.</p>
      <div class="meta">${escapeHtml(conflict.a.period)} overlaps ${escapeHtml(conflict.b.period)}</div>
    `;
    els.conflictList.appendChild(card);
  });
}

function renderDesiredList() {
  els.desiredList.innerHTML = "";
  if (!state.mustCourses.size && !state.desiredCourses.size && !state.hiddenSuggestionCourses.size) {
    els.desiredList.textContent = "No must-take or considered courses selected.";
    return;
  }

  [...state.mustCourses].sort().forEach((baseCode) => {
    const course = state.courses.find((item) => item.baseCode === baseCode);
    const chip = document.createElement("span");
    const hidden = state.hiddenSuggestionCourses.has(baseCode);
    chip.className = `desired-item must${hidden ? " hidden" : ""}`;
    chip.innerHTML = `
      <span>${course ? `Must: ${escapeHtml(course.baseCode)} ${escapeHtml(course.title)}` : `Must: ${escapeHtml(baseCode)}`}</span>
      <button data-hide-suggestion-course="${escapeHtml(baseCode)}">${hidden ? "Show" : "Hide"}</button>
      <button data-remove-suggestion-course="${escapeHtml(baseCode)}">Remove</button>
    `;
    els.desiredList.appendChild(chip);
  });

  [...state.desiredCourses].sort().forEach((baseCode) => {
    const course = state.courses.find((item) => item.baseCode === baseCode);
    const chip = document.createElement("span");
    const hidden = state.hiddenSuggestionCourses.has(baseCode);
    chip.className = `desired-item consider${hidden ? " hidden" : ""}`;
    chip.innerHTML = `
      <span>${course ? `Consider: ${escapeHtml(course.baseCode)} ${escapeHtml(course.title)}` : `Consider: ${escapeHtml(baseCode)}`}</span>
      <button data-hide-suggestion-course="${escapeHtml(baseCode)}">${hidden ? "Show" : "Hide"}</button>
      <button data-remove-suggestion-course="${escapeHtml(baseCode)}">Remove</button>
    `;
    els.desiredList.appendChild(chip);
  });

  [...state.hiddenSuggestionCourses]
    .filter((baseCode) => !state.mustCourses.has(baseCode) && !state.desiredCourses.has(baseCode))
    .sort()
    .forEach((baseCode) => {
      const course = state.courses.find((item) => item.baseCode === baseCode);
      const chip = document.createElement("span");
      chip.className = "desired-item hidden";
      chip.innerHTML = `
        <span>${course ? `Hidden: ${escapeHtml(course.baseCode)} ${escapeHtml(course.title)}` : `Hidden: ${escapeHtml(baseCode)}`}</span>
        <button data-hide-suggestion-course="${escapeHtml(baseCode)}">Show</button>
      `;
      els.desiredList.appendChild(chip);
    });

  els.desiredList.querySelectorAll("[data-hide-suggestion-course]").forEach((button) => {
    button.addEventListener("click", () => toggleHiddenSuggestionCourse(button.dataset.hideSuggestionCourse));
  });
  els.desiredList.querySelectorAll("[data-remove-suggestion-course]").forEach((button) => {
    button.addEventListener("click", () => removeSuggestionCourse(button.dataset.removeSuggestionCourse));
  });
}

function toggleHiddenSuggestionCourse(baseCode) {
  if (state.hiddenSuggestionCourses.has(baseCode)) state.hiddenSuggestionCourses.delete(baseCode);
  else state.hiddenSuggestionCourses.add(baseCode);
  renderCatalog();
  renderDesiredList();
}

function removeSuggestionCourse(baseCode) {
  state.mustCourses.delete(baseCode);
  state.desiredCourses.delete(baseCode);
  state.hiddenSuggestionCourses.delete(baseCode);
  renderCatalog();
  renderDesiredList();
}

function hideSuggestionCourseAndRegenerate(baseCode) {
  state.hiddenSuggestionCourses.add(baseCode);
  renderCatalog();
  renderDesiredList();
  renderSuggestions();
}

function renderSuggestions() {
  els.suggestions.innerHTML = "";
  const mustCourses = [...state.mustCourses]
    .filter((baseCode) => !state.hiddenSuggestionCourses.has(baseCode))
    .map((baseCode) => state.courses.find((course) => course.baseCode === baseCode))
    .filter(Boolean);
  const consideredCourses = [...state.desiredCourses]
    .filter((baseCode) => !state.hiddenSuggestionCourses.has(baseCode))
    .map((baseCode) => state.courses.find((course) => course.baseCode === baseCode))
    .filter(Boolean);

  if (!mustCourses.length && !consideredCourses.length) {
    els.suggestions.textContent = state.hiddenSuggestionCourses.size
      ? "All marked courses are hidden. Show one to generate schedules."
      : "Mark must-take or considered courses in the catalog first.";
    return;
  }

  const requiredCombinations = [];
  if (mustCourses.length) {
    searchCombinations(mustCourses, 0, [], requiredCombinations, 200);
  } else {
    requiredCombinations.push([]);
  }

  if (!requiredCombinations.length) {
    saveSuggestionHistory([], 0);
    els.suggestions.textContent = "No conflict-free schedules found for the must-take courses.";
    return;
  }

  const combinations = [];
  requiredCombinations.forEach((requiredSections) => {
    searchOptionalCombinations(consideredCourses, 0, requiredSections, combinations, 250);
  });

  const consideredCodes = new Set(consideredCourses.map((course) => course.baseCode));
  combinations.sort((a, b) => {
    const aCredits = a.reduce((sum, section) => sum + section.credits, 0);
    const bCredits = b.reduce((sum, section) => sum + section.credits, 0);
    const aOptional = a.filter((section) => consideredCodes.has(section.baseCode)).length;
    const bOptional = b.filter((section) => consideredCodes.has(section.baseCode)).length;
    return bCredits - aCredits || bOptional - aOptional || a.length - b.length;
  });
  const visibleCombinations = combinations.slice(0, 50);
  saveSuggestionHistory(visibleCombinations, combinations.length);

  if (!visibleCombinations.length) {
    els.suggestions.textContent = "No conflict-free schedules found for those courses.";
    return;
  }

  visibleCombinations.forEach((sections, index) => {
    const mustCount = sections.filter((section) => state.mustCourses.has(section.baseCode)).length;
    const consideredCount = sections.filter((section) => state.desiredCourses.has(section.baseCode)).length;
    const totalCredits = sections.reduce((sum, section) => sum + section.credits, 0);
    const card = document.createElement("article");
    card.className = "suggestion-card";
    card.innerHTML = `
      <h3>Option ${index + 1}</h3>
      <div class="meta">${totalCredits} credits · ${mustCount} must · ${consideredCount} considered fit</div>
      <ul class="suggestion-course-list">${sections.map((section) => `
        <li>
          <span>${escapeHtml(section.courseCode)} ${escapeHtml(section.title)} · ${section.meetings.map(formatMeetingBrief).join("; ")}</span>
          <button class="secondary" data-hide-result-course="${escapeHtml(section.baseCode)}">Hide</button>
        </li>
      `).join("")}</ul>
      <button data-apply="${index}">Use this schedule</button>
    `;
    els.suggestions.appendChild(card);
  });

  els.suggestions.querySelectorAll("[data-hide-result-course]").forEach((button) => {
    button.addEventListener("click", () => hideSuggestionCourseAndRegenerate(button.dataset.hideResultCourse));
  });
  els.suggestions.querySelectorAll("[data-apply]").forEach((button) => {
    button.addEventListener("click", () => {
      const sections = visibleCombinations[Number(button.dataset.apply)];
      state.selectedSections = new Set(sections.map((section) => section.key));
      setView("schedule");
      renderAll();
    });
  });
}

function saveSuggestionHistory(visibleCombinations, totalResults) {
  const must = [...state.mustCourses].sort();
  const consider = [...state.desiredCourses].sort();
  const hidden = [...state.hiddenSuggestionCourses].sort();
  if (!must.length && !consider.length && !hidden.length) return;

  const topCredits = visibleCombinations.length
    ? visibleCombinations[0].reduce((sum, section) => sum + section.credits, 0)
    : 0;
  const historyItem = {
    id: `suggestion-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    term: state.term || "Unknown term",
    createdAt: new Date().toISOString(),
    must,
    consider,
    hidden,
    resultCount: totalResults,
    shownCount: visibleCombinations.length,
    topCredits,
  };

  state.suggestionHistory = [
    historyItem,
    ...state.suggestionHistory.filter((item) => !sameSuggestionQuery(item, historyItem)),
  ].slice(0, 25);
  persistSuggestionHistory();
  renderSuggestionHistory();
}

function renderSuggestionHistory() {
  els.suggestionHistory.innerHTML = "";
  els.suggestionHistory.classList.toggle("empty", state.suggestionHistory.length === 0);

  if (!state.suggestionHistory.length) {
    els.suggestionHistory.textContent = "No suggestion history yet.";
    return;
  }

  state.suggestionHistory.forEach((item) => {
    const card = document.createElement("article");
    card.className = "history-card";
    card.innerHTML = `
      <div class="history-card-head">
        <div>
          <strong>${escapeHtml(item.term)}</strong>
          <div class="meta">${formatSavedDate(item.createdAt)} · ${item.resultCount} result${item.resultCount === 1 ? "" : "s"} · top ${item.topCredits} credits</div>
        </div>
      </div>
      <div class="history-groups">
        <div><span class="history-label">Must</span>${renderHistoryCourseChips(item.must, "must")}</div>
        <div><span class="history-label">Consider</span>${renderHistoryCourseChips(item.consider, "consider")}</div>
        ${item.hidden && item.hidden.length ? `<div><span class="history-label">Hidden</span>${renderHistoryCourseChips(item.hidden, "hidden")}</div>` : ""}
      </div>
      <div class="saved-actions">
        <button data-restore-suggestion="${escapeHtml(item.id)}">Restore and suggest</button>
        <button class="danger" data-delete-suggestion="${escapeHtml(item.id)}">Delete</button>
      </div>
    `;
    els.suggestionHistory.appendChild(card);
  });

  els.suggestionHistory.querySelectorAll("[data-restore-suggestion]").forEach((button) => {
    button.addEventListener("click", () => restoreSuggestionHistory(button.dataset.restoreSuggestion));
  });
  els.suggestionHistory.querySelectorAll("[data-delete-suggestion]").forEach((button) => {
    button.addEventListener("click", () => deleteSuggestionHistory(button.dataset.deleteSuggestion));
  });
}

function renderHistoryCourseChips(baseCodes, kind) {
  if (!baseCodes.length) return `<span class="history-empty">None</span>`;
  return baseCodes
    .map((baseCode) => {
      const course = state.courses.find((item) => item.baseCode === baseCode);
      const label = course ? `${course.baseCode} ${course.title}` : baseCode;
      return `<span class="desired-item ${kind}">${escapeHtml(label)}</span>`;
    })
    .join("");
}

function restoreSuggestionHistory(historyId) {
  const item = state.suggestionHistory.find((history) => history.id === historyId);
  if (!item) return;

  const availableBaseCodes = new Set(state.courses.map((course) => course.baseCode));
  state.mustCourses = new Set(item.must.filter((baseCode) => availableBaseCodes.has(baseCode)));
  state.desiredCourses = new Set(item.consider.filter((baseCode) => availableBaseCodes.has(baseCode)));
  state.hiddenSuggestionCourses = new Set((item.hidden || []).filter((baseCode) => availableBaseCodes.has(baseCode)));
  renderCatalog();
  renderDesiredList();
  renderSuggestions();
  setView("suggest");
}

function deleteSuggestionHistory(historyId) {
  state.suggestionHistory = state.suggestionHistory.filter((item) => item.id !== historyId);
  persistSuggestionHistory();
  renderSuggestionHistory();
}

function sameSuggestionQuery(a, b) {
  return a.term === b.term && a.must.join("|") === b.must.join("|") && a.consider.join("|") === b.consider.join("|") && (a.hidden || []).join("|") === (b.hidden || []).join("|");
}

function loadSuggestionHistory() {
  try {
    const raw = localStorage.getItem(SUGGESTION_HISTORY_KEY);
    if (!raw) return [];
    const history = JSON.parse(raw);
    return Array.isArray(history) ? history.filter(isValidSuggestionHistory) : [];
  } catch (error) {
    console.warn("Could not read suggestion history.", error);
    return [];
  }
}

function persistSuggestionHistory() {
  try {
    localStorage.setItem(SUGGESTION_HISTORY_KEY, JSON.stringify(state.suggestionHistory));
  } catch (error) {
    console.warn("Could not save suggestion history.", error);
  }
}

function isValidSuggestionHistory(item) {
  return item && typeof item.id === "string" && Array.isArray(item.must) && Array.isArray(item.consider);
}

function searchOptionalCombinations(courses, index, chosen, output, limit) {
  if (output.length >= limit) return;
  if (index === courses.length) {
    output.push([...chosen]);
    return;
  }

  for (const section of courses[index].sections) {
    const candidateMeetings = [...chosen.flatMap((item) => item.meetings), ...section.meetings];
    if (!findConflicts(candidateMeetings).length) {
      chosen.push(section);
      searchOptionalCombinations(courses, index + 1, chosen, output, limit);
      chosen.pop();
    }
  }

  searchOptionalCombinations(courses, index + 1, chosen, output, limit);
}

function searchCombinations(courses, index, chosen, output, limit) {
  if (output.length >= limit) return;
  if (index === courses.length) {
    output.push([...chosen]);
    return;
  }

  for (const section of courses[index].sections) {
    const candidateMeetings = [...chosen.flatMap((item) => item.meetings), ...section.meetings];
    if (!findConflicts(candidateMeetings).length) {
      chosen.push(section);
      searchCombinations(courses, index + 1, chosen, output, limit);
      chosen.pop();
    }
  }
}

function renderData() {
  els.dataOutput.textContent = state.meetings.length
    ? JSON.stringify(
        {
          term: state.term,
          courses: state.courses,
          meetings: state.meetings,
        },
        null,
        2
      )
    : "No data loaded.";
}

function renderSavedSchedules() {
  els.savedCount.textContent = `${state.savedSchedules.length} schedule${state.savedSchedules.length === 1 ? "" : "s"}`;
  els.savedSchedules.innerHTML = "";
  els.savedSchedules.classList.toggle("empty", state.savedSchedules.length === 0);

  if (!state.savedSchedules.length) {
    els.savedSchedules.textContent = "No saved schedules yet.";
    return;
  }

  state.savedSchedules.forEach((schedule) => {
    const stats = savedScheduleStats(schedule);
    const card = document.createElement("article");
    card.className = "saved-card";
    card.innerHTML = `
      <div class="saved-card-head">
        <div>
          <h3>${escapeHtml(schedule.name)}</h3>
          <div class="meta">${escapeHtml(schedule.term)} · ${stats.summary} · Updated ${formatSavedDate(schedule.updatedAt)}</div>
        </div>
        <span class="chip">${stats.conflicts} conflict${stats.conflicts === 1 ? "" : "s"}</span>
      </div>
      ${schedule.notes ? `<p class="saved-notes">${escapeHtml(schedule.notes)}</p>` : ""}
      <div class="saved-course-list">
        ${stats.sections.map((section) => `<span>${escapeHtml(section.courseCode)}</span>`).join("")}
        ${stats.missing ? `<span class="missing">${stats.missing} missing</span>` : ""}
      </div>
      <div class="saved-actions">
        <button data-load-schedule="${escapeHtml(schedule.id)}">Load</button>
        <button class="secondary" data-replace-schedule="${escapeHtml(schedule.id)}">Replace with current</button>
        <button class="danger" data-delete-schedule="${escapeHtml(schedule.id)}">Delete</button>
      </div>
    `;
    els.savedSchedules.appendChild(card);
  });

  els.savedSchedules.querySelectorAll("[data-load-schedule]").forEach((button) => {
    button.addEventListener("click", () => loadSavedSchedule(button.dataset.loadSchedule));
  });
  els.savedSchedules.querySelectorAll("[data-replace-schedule]").forEach((button) => {
    button.addEventListener("click", () => replaceSavedSchedule(button.dataset.replaceSchedule));
  });
  els.savedSchedules.querySelectorAll("[data-delete-schedule]").forEach((button) => {
    button.addEventListener("click", () => deleteSavedSchedule(button.dataset.deleteSchedule));
  });
}

function saveCurrentSchedule() {
  const sectionKeys = [...state.selectedSections];
  if (!sectionKeys.length) {
    showStatus("Add at least one course before saving a schedule.");
    return;
  }

  const now = new Date().toISOString();
  const schedule = {
    id: `schedule-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: cleanText(els.scheduleName.value) || defaultScheduleName(),
    notes: cleanText(els.scheduleNotes.value),
    term: state.term || "Unknown term",
    sectionKeys,
    createdAt: now,
    updatedAt: now,
  };

  state.savedSchedules.unshift(schedule);
  persistSavedScheduleFolder();
  els.scheduleName.value = "";
  els.scheduleNotes.value = "";
  renderSavedSchedules();
  showStatus(`Saved "${schedule.name}".`);
}

function loadSavedSchedule(scheduleId) {
  const schedule = state.savedSchedules.find((item) => item.id === scheduleId);
  if (!schedule) return;

  const availableKeys = schedule.sectionKeys.filter((key) => state.sections.has(key));
  state.selectedSections = new Set(availableKeys);
  setView("schedule");
  renderAll();

  const missing = schedule.sectionKeys.length - availableKeys.length;
  showStatus(missing ? `Loaded "${schedule.name}" with ${missing} missing section${missing === 1 ? "" : "s"}.` : `Loaded "${schedule.name}".`);
}

function replaceSavedSchedule(scheduleId) {
  const schedule = state.savedSchedules.find((item) => item.id === scheduleId);
  const sectionKeys = [...state.selectedSections];
  if (!schedule || !sectionKeys.length) {
    showStatus("Add at least one course before replacing a saved schedule.");
    return;
  }

  schedule.term = state.term || schedule.term;
  schedule.sectionKeys = sectionKeys;
  schedule.updatedAt = new Date().toISOString();
  persistSavedScheduleFolder();
  renderSavedSchedules();
  showStatus(`Updated "${schedule.name}".`);
}

function deleteSavedSchedule(scheduleId) {
  const schedule = state.savedSchedules.find((item) => item.id === scheduleId);
  state.savedSchedules = state.savedSchedules.filter((item) => item.id !== scheduleId);
  persistSavedScheduleFolder();
  renderSavedSchedules();
  if (schedule) showStatus(`Deleted "${schedule.name}".`);
}

function savedScheduleStats(schedule) {
  const sections = schedule.sectionKeys.map((key) => state.sections.get(key)).filter(Boolean);
  const meetings = sections.flatMap((section) => section.meetings);
  const credits = sections.reduce((sum, section) => sum + section.credits, 0);
  const conflicts = findConflicts(meetings).length;
  const missing = schedule.sectionKeys.length - sections.length;
  return {
    sections,
    missing,
    conflicts,
    summary: `${sections.length}/${schedule.sectionKeys.length} sections · ${credits} credits`,
  };
}

function loadSavedScheduleFolder() {
  try {
    const raw = localStorage.getItem(SAVED_SCHEDULES_KEY);
    if (!raw) return [];
    const saved = JSON.parse(raw);
    return Array.isArray(saved) ? saved.filter(isValidSavedSchedule) : [];
  } catch (error) {
    console.warn("Could not read saved schedules.", error);
    return [];
  }
}

function persistSavedScheduleFolder() {
  try {
    localStorage.setItem(SAVED_SCHEDULES_KEY, JSON.stringify(state.savedSchedules));
  } catch (error) {
    console.warn("Could not save schedule folder.", error);
    showStatus("Could not save schedules in this browser.");
  }
}

function isValidSavedSchedule(schedule) {
  return schedule && typeof schedule.id === "string" && typeof schedule.name === "string" && Array.isArray(schedule.sectionKeys);
}

function defaultScheduleName() {
  const nextNumber = state.savedSchedules.length + 1;
  return state.term ? `${state.term} option ${nextNumber}` : `Schedule option ${nextNumber}`;
}

function formatSavedDate(value) {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function saveLastLoadedJson(fileName) {
  const payload = {
    parserVersion: PARSER_VERSION,
    savedAt: new Date().toISOString(),
    sourceFile: fileName,
    term: state.term,
    meetings: state.meetings,
  };

  try {
    localStorage.setItem(LAST_LOADED_JSON_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("Could not save last loaded schedule.", error);
  }
}

function loadLastLoadedJson() {
  let payload;

  try {
    const raw = localStorage.getItem(LAST_LOADED_JSON_KEY);
    if (!raw) return false;
    payload = JSON.parse(raw);
  } catch (error) {
    console.warn("Could not read last loaded schedule.", error);
    return false;
  }

  if (!payload || !Array.isArray(payload.meetings) || !payload.meetings.length) {
    return false;
  }
  if (payload.parserVersion !== PARSER_VERSION) {
    showStatus("Saved PDF data was parsed with an older parser. Please reload the PDF once.");
    return false;
  }

  state.term = payload.term || "Saved Term";
  state.meetings = payload.meetings;
  buildCourseIndex();
  renderAll();
  showStatus(`Loaded saved ${state.term} schedule.`);
  return true;
}

function downloadJson() {
  if (!state.meetings.length) return;
  const blob = new Blob([els.dataOutput.textContent], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.term || "course-schedule"}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function copySelectedCrns() {
  const crns = [...new Set(getSelectedSections().map((section) => section.crn))].filter(Boolean);
  if (!crns.length) {
    showStatus("Add courses to the schedule before copying CRNs.");
    return;
  }

  const text = crns.join("\n");
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      copyTextFallback(text);
    }
    showStatus(`Copied ${crns.length} CRN${crns.length === 1 ? "" : "s"}.`);
  } catch (error) {
    console.warn("Could not copy CRNs.", error);
    showStatus("Could not copy CRNs in this browser.");
  }
}

async function copyCrn(crn) {
  if (!crn) return;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(crn);
    } else {
      copyTextFallback(crn);
    }
    showStatus(`Copied CRN ${crn}.`);
  } catch (error) {
    console.warn("Could not copy CRN.", error);
    showStatus("Could not copy this CRN in this browser.");
  }
}

function copyTextFallback(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function getSelectedSections() {
  return [...state.selectedSections].map((key) => state.sections.get(key)).filter(Boolean);
}

function getSelectedMeetings() {
  return getSelectedSections().flatMap((section) => section.meetings);
}

function getVisibleScheduleMeetings() {
  return getSelectedMeetings().filter((meeting) => meetingVisibleInPeriod(meeting, state.schedulePeriod));
}

function meetingVisibleInPeriod(meeting, periodView) {
  if (periodView === "all") return true;
  if (periodView === "first") return meeting.period !== "Second 7 Weeks (7-2)";
  if (periodView === "second") return meeting.period !== "First 7 Weeks (7-1)";
  return true;
}

function periodViewLabel(periodView) {
  if (periodView === "first") return "First 7 Weeks";
  if (periodView === "second") return "Second 7 Weeks";
  return "All";
}

function findConflicts(meetings) {
  const conflicts = [];
  for (let i = 0; i < meetings.length; i += 1) {
    for (let j = i + 1; j < meetings.length; j += 1) {
      const a = meetings[i];
      const b = meetings[j];
      const sharedDays = a.dayList.filter((day) => b.dayList.includes(day));
      if (!sharedDays.length || !periodsOverlap(a.period, b.period)) continue;
      if (a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes) {
        conflicts.push({
          a,
          b,
          day: sharedDays.join(", "),
          time: `${maxTime(a.startTime, b.startTime)}-${minTime(a.endTime, b.endTime)}`,
        });
      }
    }
  }
  return conflicts;
}

function periodsOverlap(a, b) {
  if (a === "Unknown" || b === "Unknown") return true;
  if (a === b) return true;
  if (a === "Second 7 Weeks (7-2)" && b === "First 7 Weeks (7-1)") return false;
  if (a === "First 7 Weeks (7-1)" && b === "Second 7 Weeks (7-2)") return false;
  return true;
}

function maxTime(a, b) {
  return minutesFromTime(a) >= minutesFromTime(b) ? a : b;
}

function minTime(a, b) {
  return minutesFromTime(a) <= minutesFromTime(b) ? a : b;
}

function formatMeetingBrief(meeting) {
  return `${escapeHtml(meeting.type)} ${escapeHtml(meeting.days)} ${escapeHtml(meeting.startTime)}-${escapeHtml(meeting.endTime)} · ${escapeHtml(meeting.period)} · ${escapeHtml(meeting.room)}`;
}

function courseLevel(course) {
  if (course.program === "All PhD") return "phd";
  const match = course.baseCode.match(/^[A-Z]+(\d)/);
  if (!match) return "other";
  if (match[1] === "7") return "masters";
  if (match[1] === "8") return "phd";
  return "other";
}

function courseLevelLabel(course) {
  const level = courseLevel(course);
  if (level === "masters") return "Master's level";
  if (level === "phd") return "PhD level";
  return "Other level";
}

function setView(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === `${name}View`);
  });
}

function showStatus(message) {
  els.status.textContent = message;
  els.status.classList.add("show");
  window.clearTimeout(showStatus.timeout);
  showStatus.timeout = window.setTimeout(() => els.status.classList.remove("show"), 4200);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function programClass(program) {
  const slug = cleanText(program)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `program-${slug}` : "program-unknown";
}

if (!loadLastLoadedJson()) {
  renderSchedule();
}
