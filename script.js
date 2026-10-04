const STORAGE_KEY = "daybook-planner-v1";
const DEFAULT_THEME = "light";
const DEFAULT_ACCENT = "#2d5d50";
const coursePalette = ["#719773", "#8599c0", "#d38a6c", "#c29b55", "#8e78a3", "#5e9c9d"];

let data = { courses: [], tasks: [] };
let currentView = "today";
let currentFilter = "all";
let selectedCourse = "all";
let sortByDate = false;
let toastTimer;
let state = { user: null, resetToken: null };

const elements = {
  appShell: document.querySelector(".app-shell"),
  authShell: document.querySelector("#auth-shell"),
  loginForm: document.querySelector("#login-form"),
  signupForm: document.querySelector("#signup-form"),
  loginTab: document.querySelector("#login-tab"),
  signupTab: document.querySelector("#signup-tab"),
  authTabs: document.querySelector(".auth-tabs"),
  forgotForm: document.querySelector("#forgot-form"),
  resetForm: document.querySelector("#reset-form"),
  authMessage: document.querySelector("#auth-message"),
  devResetLink: document.querySelector("#dev-reset-link"),
  taskList: document.querySelector("#task-list"),
  courseList: document.querySelector("#course-list"),
  courseSelect: document.querySelector("#task-course"),
  dialog: document.querySelector("#task-dialog"),
  form: document.querySelector("#task-form"),
  search: document.querySelector("#search-input"),
  toast: document.querySelector("#toast"),
  topbarTools: document.querySelector("#topbar-tools"),
  themeSelect: document.querySelector("#theme-select"),
  accentPicker: document.querySelector("#accent-picker"),
  logoutButton: document.querySelector("#logout-button"),
  adminButton: document.querySelector("#admin-button"),
  adminDialog: document.querySelector("#admin-dialog"),
  adminUserList: document.querySelector("#admin-user-list"),
  profileName: document.querySelector(".profile-copy strong"),
  profileMeta: document.querySelector(".profile-copy span"),
  avatar: document.querySelectorAll(".avatar"),
};

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(dateString, count) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + count);
  return localDate(date);
}

function makeStarterData() {
  const today = localDate(new Date());
  const courses = [
    { id: "biology", name: "Biology", color: coursePalette[0] },
    { id: "statistics", name: "Statistics", color: coursePalette[1] },
    { id: "literature", name: "Literature", color: coursePalette[2] },
    { id: "history", name: "History", color: coursePalette[3] }
  ];
  const tasks = [
    { id: "starter-1", title: "Read chapter 6: Cell structure", course: "biology", due: today, priority: "high", status: "todo" },
    { id: "starter-2", title: "Finish problem set 04", course: "statistics", due: today, priority: "high", status: "doing" },
    { id: "starter-3", title: "Gather sources for the research essay", course: "literature", due: addDays(today, 1), priority: "medium", status: "todo" },
    { id: "starter-4", title: "Review notes on the French Revolution", course: "history", due: addDays(today, 3), priority: "low", status: "todo" },
    { id: "starter-5", title: "Upload lab notes", course: "biology", due: addDays(today, 2), priority: "medium", status: "done", completedAt: today },
    { id: "starter-6", title: "Practice quiz: probability", course: "statistics", due: addDays(today, -2), priority: "low", status: "done", completedAt: addDays(today, -1) }
  ];
  return { courses, tasks };
}

function loadLocalData() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.courses) && Array.isArray(saved.tasks)) {
      return saved;
    }
  } catch (error) {
    console.warn("Could not load saved planner data.", error);
  }
  const starterData = makeStarterData();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(starterData));
  return starterData;
}

function applyTheme(theme, accent) {
  const normalizedTheme = theme === "forest" || theme === "sunset" ? theme : DEFAULT_THEME;
  const normalizedAccent = /^#[0-9a-fA-F]{6}$/.test(accent || DEFAULT_ACCENT) ? accent : DEFAULT_ACCENT;
  document.body.dataset.theme = normalizedTheme;
  document.documentElement.style.setProperty("--green", normalizedAccent);
  elements.themeSelect.value = normalizedTheme;
  elements.accentPicker.value = normalizedAccent;
  localStorage.setItem("daybook-theme", normalizedTheme);
  localStorage.setItem("daybook-accent", normalizedAccent);
}

function hydrateUserUI(user) {
  const profileName = user && user.name ? user.name : "Student";
  const profileMeta = user && user.email ? user.email : "Your study space";

  if (elements.profileName) {
    elements.profileName.textContent = profileName;
  }
  if (elements.profileMeta) {
    elements.profileMeta.textContent = profileMeta;
  }

  const initials = profileName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "S";
  elements.avatar.forEach((avatar) => {
    avatar.textContent = initials;
  });

  elements.topbarTools.hidden = !user;
  elements.adminButton.hidden = !user || user.role !== "admin";
}

function setAuthMode(mode) {
  const loginOpen = mode === "login";
  const signupOpen = mode === "signup";
  const tabbedMode = loginOpen || signupOpen;
  elements.authTabs.hidden = !tabbedMode;
  elements.loginTab.classList.toggle("is-active", loginOpen);
  elements.signupTab.classList.toggle("is-active", signupOpen);
  elements.loginTab.setAttribute("aria-selected", String(loginOpen));
  elements.signupTab.setAttribute("aria-selected", String(signupOpen));
  elements.loginForm.hidden = !loginOpen;
  elements.signupForm.hidden = !signupOpen;
  elements.forgotForm.hidden = mode !== "forgot";
  elements.resetForm.hidden = mode !== "reset";
  elements.authMessage.hidden = true;
  elements.authMessage.textContent = "";
  elements.authMessage.classList.remove("is-error");
  elements.devResetLink.hidden = true;
}

function setAuthMessage(message, isError = false) {
  elements.authMessage.textContent = message;
  elements.authMessage.hidden = !message;
  elements.authMessage.classList.toggle("is-error", isError);
}

function showAuth() {
  elements.authShell.classList.add("is-visible");
}

function hideAuth() {
  elements.authShell.classList.remove("is-visible");
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2300);
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || "Request failed.");
  }

  return payload;
}

function syncDataFromPayload(payload) {
  if (!payload) return;
  data = {
    courses: Array.isArray(payload.courses) ? payload.courses : [],
    tasks: Array.isArray(payload.tasks) ? payload.tasks : []
  };
  if (payload.user) {
    state.user = payload.user;
    hydrateUserUI(payload.user);
    if (payload.user.theme) {
      applyTheme(payload.user.theme, payload.user.accent || DEFAULT_ACCENT);
    }
  }
}

async function saveData() {
  try {
    if (state.user) {
      const payload = await apiRequest("/api/data", {
        method: "PUT",
        body: JSON.stringify({ courses: data.courses, tasks: data.tasks })
      });
      syncDataFromPayload(payload);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
    return true;
  } catch (error) {
    console.warn("Could not save planner data.", error);
    showToast(error.message || "Could not save your planner data.");
    return false;
  }
}

async function bootstrapSession() {
  const savedTheme = localStorage.getItem("daybook-theme") || DEFAULT_THEME;
  const savedAccent = localStorage.getItem("daybook-accent") || DEFAULT_ACCENT;
  applyTheme(savedTheme, savedAccent);

  data = loadLocalData();
  render();

  try {
    const payload = await apiRequest("/api/auth/me");
    syncDataFromPayload(payload);
    if (state.resetToken) {
      showAuth();
    } else {
      hideAuth();
    }
    render();
  } catch (error) {
    hydrateUserUI(null);
    showAuth();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const formData = new FormData(elements.loginForm);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");

  try {
    const payload = await apiRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    syncDataFromPayload(payload);
    hideAuth();
    render();
    showToast(`Welcome back, ${payload.user.name.split(" ")[0]}!`);
  } catch (error) {
    showToast(error.message || "Unable to log in.");
  }
}

async function handleSignup(event) {
  event.preventDefault();
  const formData = new FormData(elements.signupForm);
  const name = String(formData.get("name") || "").trim();
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");

  try {
    const payload = await apiRequest("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ name, email, password })
    });
    syncDataFromPayload(payload);
    hideAuth();
    render();
    showToast(`Account created for ${payload.user.name}!`);
  } catch (error) {
    showToast(error.message || "Signup failed.");
  }
}

async function handleLogout() {
  try {
    await apiRequest("/api/auth/logout", { method: "POST" });
  } catch (error) {
    console.warn("Logout request failed.", error);
    showToast(error.message || "Could not log out. Please try again.");
    return;
  }

  state.user = null;
  data = loadLocalData();
  hydrateUserUI(null);
  showAuth();
  render();
  showToast("You have been logged out.");
}

async function handleForgot(event) {
  event.preventDefault();
  const email = String(new FormData(elements.forgotForm).get("email") || "").trim();
  try {
    const payload = await apiRequest("/api/auth/forgot", {
      method: "POST",
      body: JSON.stringify({ email })
    });
    setAuthMessage("If an account exists for that email, reset instructions will be sent shortly.");
    if (payload && payload.resetLink) {
      elements.devResetLink.href = payload.resetLink;
      elements.devResetLink.textContent = "Open local development reset link";
      elements.devResetLink.hidden = false;
    }
  } catch (err) {
    console.warn('Forgot request failed.', err);
    setAuthMessage(err.message || "Could not request password reset.", true);
  }
}

async function handleResetPassword(event) {
  event.preventDefault();
  const values = new FormData(elements.resetForm);
  const password = String(values.get("password") || "");
  const confirmation = String(values.get("confirmPassword") || "");
  if (password !== confirmation) {
    setAuthMessage("The passwords do not match.", true);
    return;
  }

  try {
    await apiRequest("/api/auth/reset", {
      method: "POST",
      body: JSON.stringify({ token: state.resetToken, password })
    });
    state.resetToken = null;
    history.replaceState(null, "", window.location.pathname + window.location.search);
    elements.resetForm.reset();
    setAuthMode("login");
    setAuthMessage("Your password has been reset. You can now log in.");
  } catch (error) {
    setAuthMessage(error.message || "Could not reset your password.", true);
  }
}

// Export current account data as a JSON file
async function handleExport() {
  try {
    const payload = await apiRequest('/api/data/export');
    const filename = `daybook-export-${new Date().toISOString().slice(0,10)}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Export started.');
  } catch (err) {
    console.warn('Export failed.', err);
    showToast(err.message || 'Could not export data.');
  }
}

// Import data from a selected JSON file and send to server
async function handleImportFile(file) {
  if (!file) return;
  if (!window.confirm("Replace all your current courses and tasks with the data in this file?")) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.courses) || !Array.isArray(parsed.tasks)) {
      showToast('Invalid import file.');
      return;
    }
    const payload = await apiRequest("/api/data/import", {
      method: 'POST',
      body: JSON.stringify({ courses: parsed.courses, tasks: parsed.tasks, replace: true })
    });
    syncDataFromPayload(payload);
    render();
    showToast('Import complete.');
  } catch (err) {
    console.warn('Import failed.', err);
    showToast(err.message || 'Could not import file.');
  }
}

async function openAdminDialog() {
  elements.adminUserList.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "admin-description";
  loading.textContent = "Loading accounts…";
  elements.adminUserList.append(loading);
  elements.adminDialog.showModal();

  try {
    const payload = await apiRequest("/api/admin/users");
    elements.adminUserList.replaceChildren();
    payload.users.forEach((user) => {
      const row = document.createElement("div");
      row.className = "admin-user-row";
      const copy = document.createElement("div");
      copy.className = "admin-user-copy";
      const name = document.createElement("strong");
      name.textContent = user.name;
      const email = document.createElement("span");
      email.textContent = user.email;
      copy.append(name, email);

      const role = document.createElement("select");
      role.className = "admin-role-select";
      role.setAttribute("aria-label", `Role for ${user.email}`);
      [["user", "User"], ["admin", "Admin"]].forEach(([value, label]) => {
        const option = new Option(label, value);
        role.add(option);
      });
      role.value = user.role;
      role.disabled = user.id === state.user.id;
      role.addEventListener("change", async () => {
        role.disabled = true;
        try {
          await apiRequest(`/api/admin/users/${encodeURIComponent(user.id)}/role`, {
            method: "PUT",
            body: JSON.stringify({ role: role.value })
          });
          showToast(`${user.name}'s role updated.`);
        } catch (error) {
          role.value = user.role;
          showToast(error.message || "Could not update role.");
        } finally {
          role.disabled = user.id === state.user.id;
        }
      });
      row.append(copy, role);
      elements.adminUserList.append(row);
    });
  } catch (error) {
    elements.adminUserList.replaceChildren();
    const message = document.createElement("p");
    message.className = "auth-message is-error";
    message.textContent = error.message || "Could not load users.";
    elements.adminUserList.append(message);
  }
}

async function updateProfile() {
  if (!state.user) {
    return;
  }

  try {
    const payload = await apiRequest("/api/auth/profile", {
      method: "PUT",
      body: JSON.stringify({
        theme: elements.themeSelect.value,
        accent: elements.accentPicker.value,
        name: state.user.name
      })
    });
    state.user = payload.user;
    hydrateUserUI(payload.user);
    applyTheme(payload.user.theme, payload.user.accent);
  } catch (error) {
    console.warn("Profile update failed.", error);
    if (state.user) applyTheme(state.user.theme, state.user.accent);
    showToast(error.message || "Could not save your appearance settings.");
  }
}

function dateAtNoon(dateString) {
  return new Date(`${dateString}T12:00:00`);
}

function formatDate(dateString, options = { month: "short", day: "numeric" }) {
  return dateAtNoon(dateString).toLocaleDateString(undefined, options);
}

function courseFor(courseId) {
  return data.courses.find((course) => course.id === courseId) || { name: "Other", color: "#a0a49b" };
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function dueLabel(due) {
  const today = localDate(new Date());
  if (due < today) return { text: `Overdue · ${formatDate(due)}`, className: "is-overdue" };
  if (due === today) return { text: "Due today", className: "is-today" };
  if (due === addDays(today, 1)) return { text: "Tomorrow", className: "" };
  return { text: formatDate(due, { weekday: "short", month: "short", day: "numeric" }), className: "" };
}

function tasksForView() {
  const today = localDate(new Date());
  const query = elements.search.value.trim().toLowerCase();
  return data.tasks.filter((task) => {
    if (currentView === "today" && task.due > today) return false;
    if (currentView === "upcoming" && (task.due <= today || task.status === "done")) return false;
    if (currentView === "completed" && task.status !== "done") return false;
    if (selectedCourse !== "all" && task.course !== selectedCourse) return false;
    if (currentFilter !== "all" && task.status !== (currentFilter === "done" ? "done" : currentFilter)) return false;
    const course = courseFor(task.course);
    if (query && !`${task.title} ${course.name}`.toLowerCase().includes(query)) return false;
    return true;
  }).sort((first, second) => {
    if (sortByDate) return first.due.localeCompare(second.due) || first.title.localeCompare(second.title);
    const rank = { high: 0, medium: 1, low: 2 };
    return rank[first.priority] - rank[second.priority] || first.due.localeCompare(second.due);
  });
}

function renderTask(task, index) {
  const course = courseFor(task.course);
  const due = dueLabel(task.due);
  const statusName = { todo: "To do", doing: "In progress", done: "Done" }[task.status];
  const row = document.createElement("article");
  row.className = `task-row${task.status === "done" ? " is-done" : ""}`;
  row.style.animationDelay = `${Math.min(index * 35, 210)}ms`;
  row.innerHTML = `
    <button class="task-check" type="button" data-action="cycle" aria-label="Change status for ${escapeHTML(task.title)}" title="Change task status">
      ${task.status === "done" ? '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2 6 2.5 2.5L10 3"></path></svg>' : ""}
    </button>
    <div class="task-copy">
      <div class="task-title">${escapeHTML(task.title)}</div>
      <div class="task-meta">
        <span class="task-course"><i class="course-dot" style="background:${escapeHTML(course.color)}"></i>${escapeHTML(course.name)}</span>
        <span class="meta-separator">·</span>
        <span class="task-due ${due.className}">${escapeHTML(due.text)}</span>
        <span class="status-label status-${task.status}">${statusName}</span>
      </div>
    </div>
    <span class="priority-label priority-${task.priority}"><i></i>${task.priority[0].toUpperCase()}${task.priority.slice(1)}</span>
    <button class="delete-task" type="button" data-action="delete" aria-label="Delete ${escapeHTML(task.title)}" title="Delete task">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6h11M8 6V4.5h4V6m2.5 0-.7 9.5h-7L6.1 6m2.4 2.5v4m3-4v4"></path></svg>
    </button>`;

  row.querySelector('[data-action="cycle"]').addEventListener("click", () => cycleTask(task));
  row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteTask(task));
  elements.taskList.append(row);
}

function renderTasks() {
  const tasks = tasksForView();
  elements.taskList.replaceChildren();
  if (tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const message = elements.search.value.trim() ? "No matching tasks" : currentView === "today" ? "Nothing due today" : "You’re all caught up";
    const detail = elements.search.value.trim() ? "Try another title or course." : "Add a task whenever you’re ready for the next one.";
    empty.innerHTML = `<span class="empty-state-mark" aria-hidden="true">✳</span><strong>${message}</strong><span>${detail}</span>`;
    elements.taskList.append(empty);
  } else {
    tasks.forEach(renderTask);
  }

  document.querySelector("#filter-all-count").textContent = tasks.length;
  document.querySelector("#task-heading").textContent = selectedCourse === "all" ? (currentView === "today" ? "Today’s focus" : viewTitle()) : courseFor(selectedCourse).name;
  document.querySelector("#breadcrumb-current").textContent = selectedCourse === "all" ? viewTitle() : courseFor(selectedCourse).name;
  document.querySelector("#sort-button").innerHTML = `${sortByDate ? "Due date" : "Priority"} <span aria-hidden="true">⌄</span>`;
  document.querySelectorAll(".filter-chip").forEach((button) => button.classList.toggle("is-selected", button.dataset.filter === currentFilter));
}

function viewTitle() {
  return { today: "My day", all: "All tasks", upcoming: "Upcoming", completed: "Completed" }[currentView];
}

function renderCourses() {
  elements.courseList.replaceChildren();
  elements.courseSelect.replaceChildren();
  elements.courseSelect.add(new Option("Choose a course", ""));

  data.courses.forEach((course) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `course-item${selectedCourse === course.id ? " is-active" : ""}`;
    button.innerHTML = `<i class="course-dot" style="background:${escapeHTML(course.color)}"></i><span>${escapeHTML(course.name)}</span><span class="course-count">${data.tasks.filter((task) => task.course === course.id && task.status !== "done").length}</span>`;
    button.addEventListener("click", () => {
      selectedCourse = selectedCourse === course.id ? "all" : course.id;
      currentView = "all";
      setActiveView();
      render();
    });
    elements.courseList.append(button);
    elements.courseSelect.add(new Option(course.name, course.id));
  });
}

function renderChart() {
  const today = localDate(new Date());
  const monday = dateAtNoon(today);
  const weekday = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - weekday);

  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return localDate(date);
  });

  const counts = days.map((day) => ({
    day,
    due: data.tasks.filter((task) => task.due === day).length,
    done: data.tasks.filter((task) => task.due === day && task.status === "done").length
  }));

  const max = Math.max(2, ...counts.map((count) => count.due));
  document.querySelector("#week-chart").innerHTML = counts.map(({ day, due, done }) => {
    const dueHeight = due ? Math.max(9, Math.round((due / max) * 77)) : 4;
    const doneHeight = done ? Math.max(9, Math.round((done / max) * 77)) : 4;
    return `<div class="chart-day${day === today ? " is-today" : ""}" title="${formatDate(day, { weekday: "long", month: "short", day: "numeric" })}: ${due} due, ${done} done">
      <div class="bar-pair"><i class="chart-bar bar-active" style="height:${dueHeight}%"></i><i class="chart-bar bar-done" style="height:${doneHeight}%"></i></div>
      <span class="chart-day-label">${formatDate(day, { weekday: "narrow" })}</span>
    </div>`;
  }).join("");
}

function renderUpcoming() {
  const today = localDate(new Date());
  const upcoming = data.tasks.filter((task) => task.due > today && task.status !== "done").sort((a, b) => a.due.localeCompare(b.due)).slice(0, 3);
  const container = document.querySelector("#upcoming-list");

  if (upcoming.length === 0) {
    container.innerHTML = '<p class="upcoming-empty">No deadlines on the horizon.</p>';
    return;
  }

  container.innerHTML = upcoming.map((task) => {
    const course = courseFor(task.course);
    const due = dateAtNoon(task.due);
    return `<div class="upcoming-item">
      <div class="upcoming-date"><span>${formatDate(task.due, { month: "short" })}</span><span>${due.getDate()}</span></div>
      <div class="upcoming-copy"><strong>${escapeHTML(task.title)}</strong><span>${escapeHTML(course.name)} · ${formatDate(task.due, { weekday: "long" })}</span></div>
    </div>`;
  }).join("");
}

function renderStats() {
  const today = localDate(new Date());
  const openTasks = data.tasks.filter((task) => task.status !== "done");
  const dueToday = openTasks.filter((task) => task.due <= today).length;
  const completed = data.tasks.filter((task) => task.status === "done").length;
  const completion = data.tasks.length ? Math.round((completed / data.tasks.length) * 100) : 0;
  const weekStart = addDays(today, -((dateAtNoon(today).getDay() + 6) % 7));
  const weekDone = data.tasks.filter((task) => task.status === "done" && task.completedAt >= weekStart && task.completedAt <= today).length;

  document.querySelector("#stat-open").textContent = openTasks.length;
  document.querySelector("#stat-today").textContent = dueToday;
  document.querySelector("#stat-done").innerHTML = `${completion}<span class="stat-suffix">%</span>`;
  document.querySelector("#all-count").textContent = openTasks.length;
  document.querySelector("#today-count").textContent = dueToday;
  document.querySelector("#completed-week").textContent = weekDone;
  document.querySelector("#week-progress").style.width = `${Math.min(100, (weekDone / 5) * 100)}%`;
}

function setActiveView() {
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.view === currentView && selectedCourse === "all"));
  document.querySelectorAll(".course-item").forEach((button, index) => button.classList.toggle("is-active", data.courses[index]?.id === selectedCourse));
}

function render() {
  renderCourses();
  renderStats();
  renderChart();
  renderUpcoming();
  renderTasks();
  setActiveView();
}

async function cycleTask(task) {
  const previousStatus = task.status;
  const previousCompletedAt = task.completedAt;
  const nextStatus = { todo: "doing", doing: "done", done: "todo" }[task.status];
  task.status = nextStatus;
  if (nextStatus === "done") task.completedAt = localDate(new Date());
  else delete task.completedAt;
  if (!await saveData()) {
    const currentTask = data.tasks.find((item) => item.id === task.id);
    if (currentTask) {
      currentTask.status = previousStatus;
      if (previousCompletedAt) currentTask.completedAt = previousCompletedAt;
      else delete currentTask.completedAt;
    }
    render();
    return;
  }
  render();
  showToast(nextStatus === "done" ? "Nicely done. That’s one more off your plate." : `Task moved to ${nextStatus === "doing" ? "in progress" : "to do"}.`);
}

async function deleteTask(task) {
  const previousTasks = data.tasks;
  data.tasks = data.tasks.filter((item) => item.id !== task.id);
  if (!await saveData()) {
    data.tasks = previousTasks;
    render();
    return;
  }
  render();
  showToast("Task removed from your list.");
}

function openTaskDialog() {
  elements.form.reset();
  document.querySelector("#dialog-title").textContent = "Add a task";
  document.querySelector("#task-due").value = localDate(new Date());
  elements.courseSelect.value = data.courses[0]?.id || "";
  elements.dialog.showModal();
  document.querySelector("#task-title").focus();
}

async function addCourse() {
  const name = window.prompt("What’s the name of the course?");
  if (!name || !name.trim()) return;
  if (data.courses.some((course) => course.name.toLowerCase() === name.trim().toLowerCase())) {
    showToast("That course is already on your list.");
    return;
  }

  const index = data.courses.length;
  const course = { id: `course-${Date.now()}`, name: name.trim().slice(0, 32), color: coursePalette[index % coursePalette.length] };
  data.courses.push(course);
  if (!await saveData()) {
    data.courses = data.courses.filter((item) => item.id !== course.id);
    render();
    return;
  }
  render();
  showToast(`${name.trim()} added to your courses.`);
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    currentView = button.dataset.view;
    selectedCourse = "all";
    currentFilter = "all";
    render();
  });
});

document.querySelectorAll(".filter-chip").forEach((button) => {
  button.addEventListener("click", () => {
    currentFilter = button.dataset.filter;
    renderTasks();
  });
});

document.querySelector("#new-task").addEventListener("click", openTaskDialog);
document.querySelector("#add-task-inline").addEventListener("click", openTaskDialog);
document.querySelector("#add-course").addEventListener("click", addCourse);
document.querySelector("#see-upcoming").addEventListener("click", () => {
  currentView = "upcoming";
  selectedCourse = "all";
  currentFilter = "all";
  render();
});
document.querySelector("#sort-button").addEventListener("click", () => {
  sortByDate = !sortByDate;
  renderTasks();
});

elements.search.addEventListener("input", renderTasks);
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    elements.search.focus();
  }
  if (event.key === "Escape" && elements.dialog.open) elements.dialog.close();
});

document.querySelector("#close-dialog").addEventListener("click", () => elements.dialog.close());
document.querySelector("#cancel-dialog").addEventListener("click", () => elements.dialog.close());
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) elements.dialog.close();
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(elements.form);
  const newTask = {
    id: globalThis.crypto?.randomUUID?.() || `task-${Date.now()}`,
    title: String(formData.get("title")).trim(),
    course: String(formData.get("course")),
    due: String(formData.get("due")),
    priority: String(formData.get("priority")),
    status: String(formData.get("status"))
  };

  if (!newTask.title || !newTask.due) return;
  if (newTask.status === "done") newTask.completedAt = localDate(new Date());

  data.tasks.push(newTask);
  if (!await saveData()) {
    data.tasks = data.tasks.filter((task) => task.id !== newTask.id);
    render();
    return;
  }
  elements.dialog.close();
  currentView = "all";
  selectedCourse = "all";
  currentFilter = "all";
  elements.search.value = "";
  render();
  showToast("Task added. You’ve got this.");
});

elements.loginTab.addEventListener("click", () => setAuthMode("login"));
elements.signupTab.addEventListener("click", () => setAuthMode("signup"));
elements.loginForm.addEventListener("submit", handleLogin);
elements.signupForm.addEventListener("submit", handleSignup);
elements.forgotForm.addEventListener("submit", handleForgot);
elements.resetForm.addEventListener("submit", handleResetPassword);

elements.logoutButton.addEventListener("click", handleLogout);

document.querySelector("#forgot-link").addEventListener("click", () => {
  elements.forgotForm.reset();
  setAuthMode("forgot");
});
document.querySelectorAll("[data-auth-back]").forEach((button) => {
  button.addEventListener("click", () => setAuthMode("login"));
});

document.querySelector("#export-button").addEventListener("click", handleExport);

document.querySelector("#import-button").addEventListener("click", () => document.querySelector("#import-file").click());

document.querySelector("#import-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (file) await handleImportFile(file);
  event.target.value = "";
});

elements.adminButton.addEventListener("click", openAdminDialog);
document.querySelector("#close-admin-dialog").addEventListener("click", () => elements.adminDialog.close());
elements.adminDialog.addEventListener("click", (event) => {
  if (event.target === elements.adminDialog) elements.adminDialog.close();
});

elements.themeSelect.addEventListener("change", async () => {
  const theme = elements.themeSelect.value;
  const accent = elements.accentPicker.value;
  applyTheme(theme, accent);
  if (state.user) {
    await updateProfile();
  }
});

elements.accentPicker.addEventListener("change", async () => {
  const theme = elements.themeSelect.value;
  const accent = elements.accentPicker.value;
  applyTheme(theme, accent);
  if (state.user) {
    await updateProfile();
  }
});

document.querySelector("#today-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

hydrateUserUI(null);

function activateResetFromLocation() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("reset");
  if (!token) return;
  state.resetToken = token;
  setAuthMode("reset");
  showAuth();
  elements.resetForm.querySelector("#reset-password").focus();
}

setAuthMode("login");
window.addEventListener("hashchange", activateResetFromLocation);
activateResetFromLocation();

bootstrapSession();
