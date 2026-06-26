(function () {
  "use strict";

  // ─── Config ──────────────────────────────────────────────────────────────
  // The Next.js app proxies "/api" -> NEXT_PUBLIC_API_URL via next.config.ts
  // rewrites. A static GitHub Pages deployment has no rewrite layer, so we
  // call the upstream API directly. The API must allow CORS from the Pages
  // origin (Access-Control-Allow-Origin) for this to work.
  // var API_BASE = "https://auth-gate.holmesops.ai/supplier";
  var API_BASE = "http://localhost/supplier";

  // ─── Validation ──────────────────────────────────────────────────────────

  var TEXT_PATTERN = /^(?=.*[a-zA-Z0-9])[a-zA-Z0-9\s.,;:()\-'"/%@&+#!?]+$/;
  var MAX_EVIDENCE_SIZE = 5 * 1024 * 1024; // 5 MB
  var ALLOWED_MIME_TYPES = {
    "application/pdf": true,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
    "image/png": true,
    "image/jpeg": true,
  };
  var ALLOWED_EXTENSIONS = { ".pdf": true, ".docx": true, ".xlsx": true, ".png": true, ".jpg": true, ".jpeg": true };

  function validateTextAnswer(raw) {
    var val = raw.trim();
    if (val.length === 0) return "This field is required.";
    if (val.length < 2) return "Answer must be at least 2 characters.";
    if (val.length > 1000) return "Answer must not exceed 1000 characters.";
    if (!TEXT_PATTERN.test(val)) return "Answer contains invalid characters. Avoid using < > { } [ ] \\ ^ ~ | characters.";
    return null;
  }

  function validateEvidenceFile(file) {
    var parts = file.name.split(".");
    var ext = "." + (parts.length > 1 ? parts.pop().toLowerCase() : "");
    if (!ALLOWED_MIME_TYPES[file.type] && !ALLOWED_EXTENSIONS[ext]) {
      return '"' + file.name + '" is not an allowed file type. Accepted: PDF, DOCX, XLSX, PNG, JPG.';
    }
    if (file.size > MAX_EVIDENCE_SIZE) {
      return '"' + file.name + '" exceeds the 5 MB size limit.';
    }
    return null;
  }

  function serializeAnswer(type, value) {
    if (type === "checkbox" || type === "multiselect") {
      return JSON.stringify(Array.isArray(value) ? value : [value]);
    }
    return Array.isArray(value) ? value.join(", ") : value;
  }

  // ─── API ─────────────────────────────────────────────────────────────────

  function fetchPortalQuestions(token) {
    var url = API_BASE + "/audit-form-v2/get-audit-form?token=" + encodeURIComponent(token);
    return fetch(url, { method: "GET" })
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        var items = (data && data.questions ? data.questions : []).map(function (item) {
          return {
            qa_id: String(item.qa_id != null ? item.qa_id : ""),
            question: String(item.question != null ? item.question : ""),
            question_type: item.question_type || "text",
            required: Boolean(item.required),
            options: Array.isArray(item.options) && item.options.length > 0 ? item.options : null,
            answer: item.answer ? String(item.answer) : undefined,
          };
        });

        var auditInfo = data && data.audit_name
          ? {
              audit_name: String(data.audit_name || ""),
              audit_type: String(data.audit_type || ""),
              supplier_name: String(data.supplier_name || ""),
              description: String(data.description || ""),
              scheduled_date: String(data.scheduled_date || ""),
              submitted: Boolean(data.submitted),
              request_evidence: Boolean(data.request_evidence),
            }
          : null;

        return { questions: items, audit: auditInfo };
      });
  }

  function submitPortalResponse(token, responses, evidenceFiles) {
    var formData = new FormData();
    formData.append("responses", JSON.stringify(responses));
    evidenceFiles.forEach(function (file) {
      formData.append("evidence_files", file);
    });

    var url = API_BASE + "/audit-form-v2/submit-audit-form?token=" + encodeURIComponent(token);
    return fetch(url, { method: "POST", body: formData }).then(function (res) {
      if (!res.ok) throw new Error("Submit failed: " + res.status);
      return res.json().catch(function () { return null; });
    });
  }

  // ─── State ───────────────────────────────────────────────────────────────

  var state = {
    token: new URLSearchParams(window.location.search).get("token") || "",
    pageState: "loading", // loading | ready | submitting | submitted | error
    questions: [],
    auditInfo: null,
    answers: {}, // qa_id -> string | string[]
    fieldErrors: {}, // qa_id -> string
    evidenceFiles: [],
    evidenceFileErrors: [],
  };

  // ─── Element refs (all live in index.html) ─────────────────────────────────

  var el = {
    screenError: document.getElementById("screen-error"),
    screenSubmitted: document.getElementById("screen-submitted"),
    screenMain: document.getElementById("screen-main"),
    backBtn: document.getElementById("back-btn"),
    auditCard: document.getElementById("audit-card"),
    auditType: document.getElementById("audit-type"),
    auditTitle: document.getElementById("audit-title"),
    auditSupplier: document.getElementById("audit-supplier"),
    auditDescription: document.getElementById("audit-description"),
    skeletonWrap: document.getElementById("skeleton-wrap"),
    questionsContainer: document.getElementById("questions-container"),
    evidenceSection: document.getElementById("evidence-section"),
    evidenceInput: document.getElementById("evidence-input"),
    evidenceFileList: document.getElementById("evidence-file-list"),
    evidenceErrorList: document.getElementById("evidence-error-list"),
    footer: document.getElementById("footer"),
    submitBtn: document.getElementById("submit-btn"),
    submitSpinner: document.getElementById("submit-spinner"),
  };

  el.backBtn.addEventListener("click", function () {
    window.history.back();
  });
  el.submitBtn.addEventListener("click", handleSubmit);
  el.evidenceInput.addEventListener("change", handleEvidenceFilesChange);

  // ─── Screen switching ───────────────────────────────────────────────────────

  function showScreen(name) {
    el.screenError.classList.toggle("hidden", name !== "error");
    el.screenSubmitted.classList.toggle("hidden", name !== "submitted");
    el.screenMain.classList.toggle("hidden", name !== "main");
  }

  // ─── Render: audit card ──────────────────────────────────────────────────

  function renderAuditCard() {
    var a = state.auditInfo;
    if (!a) {
      el.auditCard.classList.add("hidden");
      return;
    }
    el.auditCard.classList.remove("hidden");
    el.auditType.textContent = a.audit_type;
    el.auditTitle.textContent = a.audit_name;
    el.auditSupplier.textContent = "For " + a.supplier_name;
    if (a.description) {
      el.auditDescription.textContent = a.description;
      el.auditDescription.classList.remove("hidden");
    } else {
      el.auditDescription.classList.add("hidden");
    }
  }

  // ─── Render: questions ───────────────────────────────────────────────────

  function valueForQuestion(q) {
    if (state.answers[q.qa_id] !== undefined) return state.answers[q.qa_id];
    return q.question_type === "checkbox" || q.question_type === "multiselect" ? [] : "";
  }

  function buildQuestionCard(q, index) {
    var value = valueForQuestion(q);
    var error = state.fieldErrors[q.qa_id] || null;

    var card = document.createElement("div");
    card.className = "question-card" + (error ? " has-error" : "");
    card.id = "q-" + q.qa_id;

    var body = document.createElement("div");
    body.className = "question-body";

    var number = document.createElement("div");
    number.className = "q-number";
    number.textContent = String(index + 1);

    var content = document.createElement("div");
    content.className = "q-content";

    var text = document.createElement("p");
    text.className = "q-text";
    text.textContent = q.question;
    if (q.required) {
      var req = document.createElement("span");
      req.className = "q-required";
      req.textContent = "*";
      text.appendChild(req);
    }

    var inputArea = document.createElement("div");
    inputArea.className = "q-input-area";
    inputArea.appendChild(buildQuestionInput(q, value));

    content.appendChild(text);
    content.appendChild(inputArea);

    if (error) {
      var errEl = document.createElement("p");
      errEl.className = "q-error";
      errEl.textContent = error;
      content.appendChild(errEl);
    }

    body.appendChild(number);
    body.appendChild(content);
    card.appendChild(body);
    return card;
  }

  function buildQuestionInput(q, value) {
    if (q.question_type === "text") {
      var textarea = document.createElement("textarea");
      textarea.rows = 4;
      textarea.className = "q-textarea";
      textarea.placeholder = "Your answer...";
      textarea.value = typeof value === "string" ? value : "";
      textarea.addEventListener("input", function () {
        handleChange(q.qa_id, textarea.value);
      });
      return textarea;
    }

    if (q.question_type === "radio" && q.options) {
      var radioWrap = document.createElement("div");
      radioWrap.className = "option-list";
      q.options.forEach(function (opt) {
        var label = document.createElement("label");
        label.className = "option-label";

        var input = document.createElement("input");
        input.type = "radio";
        input.name = q.qa_id;
        input.value = opt;
        input.checked = value === opt;
        input.addEventListener("change", function () {
          handleChange(q.qa_id, opt);
        });

        var span = document.createElement("span");
        span.textContent = opt;

        label.appendChild(input);
        label.appendChild(span);
        radioWrap.appendChild(label);
      });
      return radioWrap;
    }

    if ((q.question_type === "checkbox" || q.question_type === "multiselect") && q.options) {
      var checkWrap = document.createElement("div");
      checkWrap.className = "option-list";
      q.options.forEach(function (opt) {
        var label = document.createElement("label");
        label.className = "option-label";

        var input = document.createElement("input");
        input.type = "checkbox";
        input.value = opt;
        input.checked = Array.isArray(value) && value.indexOf(opt) !== -1;
        input.addEventListener("change", function () {
          var current = Array.isArray(state.answers[q.qa_id]) ? state.answers[q.qa_id].slice() : [];
          if (input.checked) {
            current.push(opt);
          } else {
            current = current.filter(function (v) { return v !== opt; });
          }
          handleChange(q.qa_id, current);
        });

        var span = document.createElement("span");
        span.textContent = opt;

        label.appendChild(input);
        label.appendChild(span);
        checkWrap.appendChild(label);
      });
      return checkWrap;
    }

    if (q.question_type === "file_upload") {
      var label = document.createElement("label");
      label.className = "file-drop";

      var labelText = document.createElement("span");
      labelText.className = "file-drop-label";
      labelText.textContent = "Click to upload a file";

      var input = document.createElement("input");
      input.type = "file";
      input.addEventListener("change", function () {
        var file = input.files && input.files[0];
        if (file) handleChange(q.qa_id, file.name);
      });

      label.appendChild(labelText);
      label.appendChild(input);

      if (typeof value === "string" && value) {
        var nameEl = document.createElement("span");
        nameEl.className = "file-drop-name";
        nameEl.textContent = value;
        label.appendChild(nameEl);
      }

      return label;
    }

    var empty = document.createElement("div");
    return empty;
  }

  function renderQuestions() {
    el.questionsContainer.innerHTML = "";
    state.questions.forEach(function (q, i) {
      el.questionsContainer.appendChild(buildQuestionCard(q, i));
    });
  }

  // ─── Render: evidence section ────────────────────────────────────────────

  function renderEvidenceSection() {
    var requested = state.auditInfo && state.auditInfo.request_evidence;
    el.evidenceSection.classList.toggle("hidden", !requested);
    if (!requested) return;

    el.evidenceFileList.innerHTML = "";
    state.evidenceFiles.forEach(function (file, idx) {
      var li = document.createElement("li");
      li.className = "evidence-file-item";

      var nameSpan = document.createElement("span");
      nameSpan.className = "evidence-file-name";
      nameSpan.textContent = file.name;

      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "evidence-remove-btn";
      removeBtn.innerHTML = "&times;";
      removeBtn.addEventListener("click", function () {
        state.evidenceFiles = state.evidenceFiles.filter(function (_, i) { return i !== idx; });
        renderEvidenceSection();
      });

      li.appendChild(nameSpan);
      li.appendChild(removeBtn);
      el.evidenceFileList.appendChild(li);
    });
    el.evidenceFileList.classList.toggle("hidden", state.evidenceFiles.length === 0);

    el.evidenceErrorList.innerHTML = "";
    state.evidenceFileErrors.forEach(function (err) {
      var li = document.createElement("li");
      li.className = "evidence-error-item";
      li.textContent = err;
      el.evidenceErrorList.appendChild(li);
    });
    el.evidenceErrorList.classList.toggle("hidden", state.evidenceFileErrors.length === 0);
  }

  function handleEvidenceFilesChange(e) {
    var files = Array.from(e.target.files || []);
    var errs = [];
    var valid = [];
    files.forEach(function (file) {
      var err = validateEvidenceFile(file);
      if (err) errs.push(err);
      else valid.push(file);
    });
    state.evidenceFileErrors = errs;
    if (valid.length) state.evidenceFiles = state.evidenceFiles.concat(valid);
    e.target.value = "";
    renderEvidenceSection();
  }

  // ─── Render: full ready/loading/submitting view ─────────────────────────

  function renderMain() {
    showScreen("main");
    renderAuditCard();

    var loading = state.pageState === "loading";
    el.skeletonWrap.classList.toggle("hidden", !loading);
    el.questionsContainer.classList.toggle("hidden", loading);
    el.footer.classList.toggle("hidden", loading);

    if (!loading) {
      renderQuestions();
      renderEvidenceSection();
    }

    var submitting = state.pageState === "submitting";
    el.submitBtn.disabled = submitting;
    el.submitSpinner.classList.toggle("hidden", !submitting);
  }

  function render() {
    if (state.pageState === "submitted") return showScreen("submitted");
    if (state.pageState === "error") return showScreen("error");
    return renderMain();
  }

  // ─── Handlers ────────────────────────────────────────────────────────────

  function handleChange(qaId, value) {
    state.answers[qaId] = value;
    delete state.fieldErrors[qaId];
    // Clear the inline error without a full re-render so focus/scroll position is preserved.
    var card = document.getElementById("q-" + qaId);
    if (card) {
      card.classList.remove("has-error");
      var errEl = card.querySelector(".q-error");
      if (errEl) errEl.remove();
    }
  }

  function handleSubmit() {
    var newErrors = {};

    state.questions.forEach(function (q) {
      var val = state.answers[q.qa_id];

      if (q.question_type === "text") {
        var raw = typeof val === "string" ? val : "";
        if (q.required && raw.trim().length === 0) {
          newErrors[q.qa_id] = "This field is required.";
        } else if (raw.trim().length > 0) {
          var msg = validateTextAnswer(raw);
          if (msg) newErrors[q.qa_id] = msg;
        }
      } else {
        if (q.required) {
          var empty = !val || (Array.isArray(val) && val.length === 0) || val === "";
          if (empty) newErrors[q.qa_id] = "This field is required.";
        }
      }
    });

    if (Object.keys(newErrors).length > 0) {
      state.fieldErrors = newErrors;
      renderQuestions();
      var firstId = state.questions.find(function (q) { return newErrors[q.qa_id]; });
      if (firstId) {
        var target = document.getElementById("q-" + firstId.qa_id);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }

    state.pageState = "submitting";
    render();

    var responses = state.questions
      .filter(function (q) { return state.answers[q.qa_id] !== undefined; })
      .map(function (q) {
        var raw = q.question_type === "text" ? state.answers[q.qa_id].trim() : (state.answers[q.qa_id] || "");
        return { qa_id: q.qa_id, answer: serializeAnswer(q.question_type, raw) };
      });

    submitPortalResponse(state.token, responses, state.evidenceFiles)
      .then(function () {
        state.pageState = "submitted";
        render();
      })
      .catch(function () {
        state.pageState = "ready";
        render();
      });
  }

  // ─── Init ────────────────────────────────────────────────────────────────

  function load() {
    fetchPortalQuestions(state.token)
      .then(function (result) {
        state.questions = result.questions;
        state.auditInfo = result.audit;

        if (result.audit && result.audit.submitted) {
          state.pageState = "submitted";
          render();
          return;
        }

        var prefilled = {};
        result.questions.forEach(function (q) {
          if (q.answer) {
            if (q.question_type === "checkbox" || q.question_type === "multiselect") {
              try {
                prefilled[q.qa_id] = JSON.parse(q.answer);
              } catch (e) {
                prefilled[q.qa_id] = q.answer;
              }
            } else {
              prefilled[q.qa_id] = q.answer;
            }
          }
        });
        state.answers = prefilled;
        state.pageState = "ready";
        render();
      })
      .catch(function () {
        state.pageState = "error";
        render();
      });
  }

  render(); // initial loading view
  load();
})();
