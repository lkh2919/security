(function () {
  "use strict";
  var D = JSON.parse(document.getElementById("dashboard-data").textContent);
  var SEV = [["critical", "치명 (Critical)"], ["high", "높음 (High)"], ["medium", "중간 (Medium)"], ["low", "낮음 (Low)"], ["confirm", "확인 필요 (Confirm)"]];
  var SEVL = {}; SEV.forEach(function (s) { SEVL[s[0]] = s[1]; });
  var STATUS = { no_update: "개정 후 갱신 없음", compared: "변경 확인", no_history: "이력 없음", failed: "확인 실패", skipped: "건너뜀" };
  var CONF = { high: "높음", medium: "보통", low: "낮음" };
  var DISC = D.meta.disclaimer;

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
    return e;
  }
  function badge(text, cls) { return h("span", { class: "badge " + cls }, text); }
  function sevBadge(s) { return badge(SEVL[s] || s, "b-" + s); }
  function disc() { return h("p", { class: "disc" }, DISC); }
  function stat(n, l) { return h("div", { class: "card stat" }, [h("div", { class: "n" }, String(n)), h("div", { class: "l" }, l)]); }
  function table(head, rows) {
    return h("div", { class: "scroll" }, h("table", null, [
      h("thead", null, h("tr", null, head.map(function (x) { return h("th", null, x); }))),
      h("tbody", null, rows.map(function (r) { return h("tr", null, r.map(function (c) { return h("td", null, c); })); }))
    ]));
  }
  function empty(t) { return h("div", { class: "card empty" }, t); }
  function secName(id, title) { return id + (title ? " " + title : ""); }
  function loc(f) { return secName(f.sectionId, f.sectionTitle) + (f.para ? " 제" + f.para + "문단" : " (문단 미확인)"); }

  function overview() {
    var o = D.overview, el = h("section");
    el.appendChild(disc());
    var g = o.gates;
    el.appendChild(h("div", { class: "grid" }, [
      stat(o.laws.length, "감시 중인 법령·고시"),
      stat(o.policies.length, "등록된 처리방침"),
      stat(o.bySeverity.critical + o.bySeverity.high, "치명·높음 지적"),
      stat(g ? g.pass + " / " + g.fail + " / " + g.skip : "-", "품질 게이트 통과 / 실패 / 건너뜀")
    ]));
    var sev = h("div", { class: "card" }, [h("h3", null, "심각도별 건수 (등록된 처리방침 합계)"), h("div", { class: "row" }, SEV.map(function (s) {
      return h("span", null, [sevBadge(s[0]), " ", h("b", null, String(o.bySeverity[s[0]])), "  "]);
    }))]);
    el.appendChild(sev);
    el.appendChild(h("h2", null, "감시 중인 법령"));
    el.appendChild(table(["법령", "코드", "최근 개정(공포)", "시행일", "비고"], o.laws.map(function (l) {
      return [l.name, l.code || "-", l.promulgated ? l.promulgated + (l.promulgationNo ? " (제" + l.promulgationNo + "호)" : "") : "-", l.effectiveOn || "-",
        l.manualReview ? badge("수동 검토", "b-info") : l.freshness === "check_failed" ? badge("확인 실패", "b-skip") : ""];
    })));
    el.appendChild(h("h2", null, "등록된 처리방침"));
    el.appendChild(o.policies.length ? table(["처리방침", "마지막 점검", "치명", "높음", "중간", "낮음", "확인 필요", ""], o.policies.map(function (p) {
      return [p.policyId, p.checkedAt.slice(0, 16).replace("T", " "), String(p.bySeverity.critical), String(p.bySeverity.high), String(p.bySeverity.medium), String(p.bySeverity.low), String(p.bySeverity.confirm),
        p.manualReview ? badge("금융: 수동 검토 필요", "b-info") : ""];
    })) : empty("점검 결과가 없습니다."));
    el.appendChild(h("div", { class: "card" }, [h("h3", null, "모델 사용량"), h("div", null, o.cost.line)]));
    return el;
  }

  function amendCard(a) {
    var c = h("div", { class: "card" + (a.noImpact ? " noimpact" : "") });
    c.appendChild(h("div", { class: "row sp" }, [
      h("h3", null, a.lawNameKo + " (" + a.law + ") " + a.promulgationNo),
      a.noImpact ? badge(a.noImpactLabel, "b-ok") : badge(a.tier, a.tier === "확정" ? "b-ok" : "b-prov")
    ]));
    c.appendChild(h("div", { class: "mute" }, "공포 " + a.promulgated + " · 시행 " + a.effectiveOn + " · 변경 단위 " + a.diffUnitCount + "개 · 직전 버전 " + (a.previous.promulgationNo || "-")));
    if (a.noImpact) {
      c.appendChild(h("p", null, a.noImpactLabel));
      c.appendChild(h("p", { class: "mute" }, "변경된 조문(" + a.articles.map(function (x) { return x.units.join(", "); }).join(", ") + ")은 처리방침 항목에 연결된 규칙 근거가 없어 점검 대상 정책에 알림을 내지 않았습니다. 이 판단은 도메인 검토 전 의견입니다."));
    } else {
      c.appendChild(h("p", { class: "mute" }, "영향 판단은 규칙 팩 법령 근거 연결 기준이며, 도메인 전문가 검토 전에는 참고용입니다."));
      c.appendChild(h("h3", null, "영향 받는 처리방침 항목 (" + a.sections.length + "개)"));
      c.appendChild(table(["항목", "변경 조문 단위", "관련 규칙"], a.sections.map(function (s) {
        return [secName(s.sectionId, s.title), h("span", { class: "units" }, s.units.join(", ")), s.rules.join(", ")];
      })));
      c.appendChild(h("h3", { style: "margin-top:14px" }, "처리방침별 수정 필요 위치"));
      if (a.policyFindings.length) {
        a.policyFindings.forEach(function (f) {
          c.appendChild(h("div", { class: "finding" }, [
            h("div", { class: "row" }, [h("b", null, f.policyId), " ", loc({ sectionId: f.sectionId, sectionTitle: "", para: f.para }), badge(f.tier, f.tier === "확정" ? "b-ok" : "b-prov"), sevBadge(f.severity)]),
            f.quote ? h("div", { class: "quote" }, f.quote) : null,
            h("div", { class: "fix" }, [h("b", null, "수정 방향: "), f.fixHint || f.message])
          ]));
        });
      } else {
        c.appendChild(h("div", { class: "mute" }, "개정 영향(Mode B) 점검 결과가 아직 없습니다. 개정 전·후 법령 파일로 점검을 실행하면 정책별 위치가 표시됩니다."));
        if (a.modeAOverlap.length) {
          c.appendChild(h("div", { class: "mute", style: "margin-top:8px" }, "참고: 현재 점검(Mode A)에서 같은 항목에 이미 지적된 사항"));
          a.modeAOverlap.forEach(function (f) {
            c.appendChild(h("div", { class: "finding" }, [
              h("div", { class: "row" }, [h("b", null, f.policyId), " ", f.sectionId + (f.para ? " 제" + f.para + "문단" : ""), sevBadge(f.severity)]),
              f.quote ? h("div", { class: "quote" }, f.quote) : null,
              h("div", { class: "fix" }, [h("b", null, "수정 방향: "), f.fixHint])
            ]));
          });
        }
      }
      c.appendChild(h("h3", { style: "margin-top:14px" }, "변경된 조문 (" + a.articles.length + "개 조)"));
      a.articles.forEach(function (ar) {
        c.appendChild(h("details", null, [
          h("summary", null, "제" + ar.article.replace("-", "조의") + (ar.article.indexOf("-") >= 0 ? "" : "조") + (ar.title ? " " + ar.title : "") + "  "),
          h("div", { class: "row" }, [badge("변경 " + ar.units.length + "개 단위", "b-info")].concat(ar.sectionIds.length ? ar.sectionIds.map(function (s) { return badge("→ " + s, "b-prov"); }) : [badge("처리방침 항목 연결 없음", "b-skip")])),
          h("div", { class: "units" }, ar.units.join(", "))
        ]));
      });
    }
    return c;
  }
  function impact() {
    var el = h("section");
    el.appendChild(disc());
    if (!D.amendments.length) el.appendChild(empty("개정 정보가 없습니다."));
    D.amendments.slice().sort(function (a, b) { return (a.noImpact ? 1 : 0) - (b.noImpact ? 1 : 0); }).forEach(function (a) { el.appendChild(amendCard(a)); });
    return el;
  }

  function check() {
    var el = h("section");
    el.appendChild(disc());
    if (!D.policies.length) el.appendChild(empty("점검 결과가 없습니다. 점검 실행 후 다시 생성하세요."));
    D.policies.forEach(function (p) {
      var c = h("div", { class: "card" });
      c.appendChild(h("div", { class: "row sp" }, [h("h3", null, p.policyId), h("div", { class: "row" }, [p.manualReview ? badge("금융: 수동 검토 필요", "b-info") : null, h("span", { class: "mute" }, p.checkedAt.slice(0, 16).replace("T", " ") + " · 규칙 팩 " + p.rulePackVersion)])]));
      c.appendChild(h("div", { class: "row" }, SEV.map(function (s) { return h("span", null, [sevBadge(s[0]), " ", h("b", null, String(p.bySeverity[s[0]]))]); })));
      [["critical", "high", "medium", "low"]].forEach(function (order) {
        order[0] && order.forEach(function (sv) {
          var list = p.findings.filter(function (f) { return f.severity === sv; });
          if (!list.length) return;
          c.appendChild(h("h3", { style: "margin-top:14px" }, [sevBadge(sv), " " + list.length + "건"]));
          list.forEach(function (f) {
            c.appendChild(h("div", { class: "finding" }, [
              h("div", { class: "row" }, [h("b", null, loc(f)), h("span", { class: "mute" }, f.ruleId)]),
              f.quote ? h("div", { class: "quote" }, f.quote) : h("div", { class: "mute" }, "해당 문구 없음 (기재 누락 가능)"),
              h("div", null, f.message),
              h("div", { class: "fix" }, [h("b", null, "수정 방향: "), f.fixHint])
            ]));
          });
        });
      });
      if (p.confirmSections.length) {
        c.appendChild(h("h3", { style: "margin-top:14px" }, [sevBadge("confirm"), " 항목별 확인 질문"]));
        c.appendChild(h("div", { class: "mute" }, "운영 사실에 따라 달라지는 사항입니다. 위반으로 판단한 것이 아닙니다."));
        p.confirmSections.forEach(function (s) {
          c.appendChild(h("details", null, [
            h("summary", null, secName(s.sectionId, s.title) + " (" + s.questions.length + "건)"),
            h("ul", { class: "tight" }, s.questions.map(function (q) { return h("li", null, q); }))
          ]));
        });
      }
      el.appendChild(c);
    });
    return el;
  }

  function peers() {
    var P = D.peers, el = h("section");
    el.appendChild(h("p", { class: "label-fixed" }, D.meta.peerLabel));
    el.appendChild(disc());
    if (!P) { el.appendChild(empty("동종사 동향 자료가 없습니다.")); return el; }
    var t = P.totals;
    el.appendChild(h("p", { class: "mute" }, P.law + " 개정 공포 " + P.amendment.promulgatedOn + " (제" + P.amendment.promulgationNo + "호) · 시행 " + P.amendment.effectiveOn + " · 확인 기준일 " + String(P.asOf).slice(0, 10) + " · 개정 전후 비교 가능한 곳만 집계"));
    el.appendChild(h("div", { class: "grid" }, [stat(t.active, "확인 대상 동종사"), stat(t.changed, "개정 후 변경 확인"), stat(t.noUpdate, "개정 후 갱신 없음"), stat(t.noHistory + t.failed + t.skipped, "이력 없음·확인 실패·건너뜀")]));
    el.appendChild(h("h2", null, "그룹별 집계"));
    el.appendChild(table(["그룹", "확인 대상", "변경", "갱신 없음", "이력 없음", "확인 실패"], P.groups.map(function (g) {
      return [g.nameKo, String(g.active), String(g.changed), String(g.noUpdate), String(g.noHistory), String(g.failed)];
    })));
    el.appendChild(h("h2", null, "조문 단위 동시 변경 (같은 그룹 내 k/n)"));
    el.appendChild(h("p", { class: "mute" }, "n곳 중 k곳이 개정 후 같은 조문과 관련된 항목을 고쳤다는 뜻입니다. 순위나 회사별 점수는 제공하지 않습니다."));
    var rows = [];
    P.groups.forEach(function (g) {
      g.signals.forEach(function (s) { rows.push([g.nameKo, s.articleKey, s.sectionId, s.k + " / " + s.n + " (" + s.windowDays + "일)", CONF[s.confidence] || s.confidence, s.meetsThreshold ? badge("기준 충족", "b-ok") : badge("참고", "b-skip")]); });
    });
    el.appendChild(rows.length ? table(["그룹", "조문", "처리방침 항목", "k / n", "신뢰도", "기준"], rows) : empty("조문 단위 신호가 없습니다."));
    el.appendChild(h("h2", null, "상세: 동종사별 확인 상태"));
    P.groups.forEach(function (g) {
      el.appendChild(h("details", null, [
        h("summary", null, g.nameKo + " (" + g.peers.length + "곳)"),
        table(["동종사", "상태", "변경 항목"], g.peers.map(function (p) { return [p.name, STATUS[p.status] || p.status, p.changedSectionIds.join(", ") || "-"]; }))
      ]));
    });
    return el;
  }

  function gates() {
    var G = D.gates, el = h("section");
    el.appendChild(disc());
    if (!G) { el.appendChild(empty("품질 게이트 결과가 없습니다.")); return el; }
    el.appendChild(h("div", { class: "grid" }, [stat(G.pass, "통과"), stat(G.fail, "실패"), stat(G.skip, "건너뜀"), stat(G.total, "전체")]));
    el.appendChild(h("p", { class: "mute" }, "실행 " + G.stamp + " · 모드 " + G.mode + " · 규칙 팩 " + G.rulePack + (G.labelStatus ? " · " + G.labelStatus : "")));
    el.appendChild(table(["게이트", "항목", "기준", "값", "상태"], G.gates.map(function (x) {
      return [x.id, h("div", null, [x.label, x.note ? h("div", { class: "mute" }, x.note) : null]), x.threshold, x.value, badge(x.status === "pass" ? "통과" : x.status === "fail" ? "실패" : "건너뜀", x.status === "pass" ? "b-ok" : x.status === "fail" ? "b-fail" : "b-skip")];
    })));
    return el;
  }

  var VIEWS = { overview: overview, impact: impact, check: check, peers: peers, gates: gates };
  var main = document.getElementById("main");
  function show(tab) {
    if (!VIEWS[tab]) tab = "overview";
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (b) { b.setAttribute("aria-selected", b.getAttribute("data-tab") === tab ? "true" : "false"); });
    main.textContent = "";
    main.appendChild(VIEWS[tab]());
    try { history.replaceState(null, "", "#" + tab); } catch (e) { /* file:// may refuse */ }
  }
  document.getElementById("orgName").textContent = D.meta.org;
  document.getElementById("genAt").textContent = "생성 " + D.meta.generatedAt.slice(0, 16).replace("T", " ") + " UTC · 규칙 팩 " + D.meta.rulePack + " · 오프라인 정적 페이지";
  document.getElementById("tabs").addEventListener("click", function (e) { var t = e.target && e.target.getAttribute && e.target.getAttribute("data-tab"); if (t) show(t); });
  show((location.hash || "").slice(1));
})();
