/*
 * Atlas Pronostics — app.js
 * Vanilla JS pur, aucune dépendance.
 *
 * Version intégrant les études de littérature :
 * - charge arbre_decision.json
 * - charge base_etudes.json
 * - matche les études aux traitements recommandés par tags
 */

(function () {
  'use strict';

  var tree = null;
  var etudes = [];
  var current = null;
  var history = [];
  var maxDepth = 1;

  function $(id) { return document.getElementById(id); }

  /* ════════════════════════════════════════════════════════════
     HELPERS TEXTE / MATCHING
  ════════════════════════════════════════════════════════════ */

  function normaliser(v) {
    return String(v || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[+±]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function contient(txt, mots) {
    var n = normaliser(txt);
    return mots.some(function (m) { return n.indexOf(normaliser(m)) !== -1; });
  }

  function sourceDuNoeud(node) {
    if (!node) return 'Référentiel SENORIF';
    if (node.source_senorif) return node.source_senorif;
    if (node.infos_science && node.infos_science.source) return node.infos_science.source;
    return 'Référentiel SENORIF';
  }

  function extraireTraitementsRecommandes(donnees) {
    var t = [];
    Object.keys(donnees || {}).forEach(function (k) {
      var v = String(donnees[k] || '').trim();
      if (v === '1' || v === '1.0' || v === '0.5') {
        t.push(k.replace(/^OUT_/i, ''));
      }
    });
    return t;
  }

  function construireProfilTexte() {
    return history.map(function (h) {
      var q = h.node && h.node.titre ? h.node.titre : '';
      var r = h.label || '';
      return q + ' ' + r;
    }).join(' ');
  }

  function tagsDepuisTraitement(t) {
    var n = normaliser(t);
    var tags = [];

    function add() {
      Array.prototype.slice.call(arguments).forEach(function (x) {
        if (tags.indexOf(x) === -1) tags.push(x);
      });
    }

    if (n.indexOf('anti her2') !== -1 || n.indexOf('her2') !== -1) add('her2', 'anti-her2', 'HER2+');
    if (n.indexOf('trastuzumab') !== -1 || n.indexOf('herceptin') !== -1) add('trastuzumab', 'anti-her2', 'her2');
    if (n.indexOf('pertuzumab') !== -1) add('pertuzumab', 'trastuzumab', 'anti-her2', 'her2');
    if (n.indexOf('t dm1') !== -1 || n.indexOf('tdm1') !== -1) add('t-dm1', 'post-neoadjuvant', 'residual-disease', 'her2');
    if (n.indexOf('t dxd') !== -1 || n.indexOf('deruxtecan') !== -1) add('t-dxd', 'ligne-ulterieure-metastatique', 'metastatique', 'her2');
    if (n.indexOf('tucatinib') !== -1) add('tucatinib', 'ligne-ulterieure-metastatique', 'metastatique', 'her2');
    if (n.indexOf('neratinib') !== -1) add('neratinib', 'adjuvant', 'her2');
    if (n.indexOf('margetuximab') !== -1) add('margetuximab', 'ligne-ulterieure-metastatique', 'metastatique', 'her2');
    if (n.indexOf('chimiotherapie') !== -1 || n.indexOf('chimiotherapie') !== -1) add('chimiotherapie');
    if (n.indexOf('paclitaxel') !== -1) add('paclitaxel-trastuzumab', 'chimiotherapie');
    if (n.indexOf('neoadjuvant') !== -1 || n.indexOf('avant chirurgie') !== -1) add('neoadjuvant');
    if (n.indexOf('adjuvant') !== -1 || n.indexOf('apres chirurgie') !== -1) add('adjuvant');
    if (n.indexOf('metastatique') !== -1 || n.indexOf('metastase') !== -1) add('metastatique');
    if (n.indexOf('ligne ulterieure') !== -1 || n.indexOf('progression') !== -1) add('ligne-ulterieure-metastatique');
    if (n.indexOf('1l') !== -1 || n.indexOf('premier traitement') !== -1 || n.indexOf('1ere ligne') !== -1) add('ligne-1-metastatique');
    if (n.indexOf('radiotherapie') !== -1 || n === 'rt') add('radiotherapie');

    return tags;
  }

  function tagsDepuisResultat(traitements, profilTexte) {
    var tags = [];
    function addTag(x) { if (tags.indexOf(x) === -1) tags.push(x); }

    traitements.forEach(function (t) {
      tagsDepuisTraitement(t).forEach(addTag);
    });

    var p = normaliser(profilTexte);
    if (p.indexOf('her2') !== -1) ['her2','anti-her2','HER2+'].forEach(addTag);
    if (p.indexOf('metastatique') !== -1 || p.indexOf('metastase') !== -1) addTag('metastatique');
    if (p.indexOf('traitement apres progression') !== -1) addTag('ligne-ulterieure-metastatique');
    if (p.indexOf('premier traitement') !== -1) addTag('ligne-1-metastatique');
    if (p.indexOf('avant la chirurgie') !== -1 || p.indexOf('neoadjuvant') !== -1) addTag('neoadjuvant');
    if (p.indexOf('apres la chirurgie') !== -1 || p.indexOf('adjuvant') !== -1) addTag('adjuvant');

    return tags;
  }

  function scoreEtudePourResultat(etude, traitements, profilTexte) {
    var resultTags = tagsDepuisResultat(traitements, profilTexte);
    var studyTags = etude.tags || [];

    var matched = [];
    studyTags.forEach(function (tag) {
      if (resultTags.indexOf(tag) !== -1) matched.push(tag);
    });

    var score = matched.length * 20;

    // Bonus si le nom exact du traitement apparaît dans la référence/interventions.
    var studyText = normaliser([
      etude.reference,
      etude.objectif,
      etude.type_etude,
      etude.issues,
      JSON.stringify(etude.interventions || {})
    ].join(' '));

    traitements.forEach(function (t) {
      tagsDepuisTraitement(t).forEach(function (tag) {
        if (studyText.indexOf(normaliser(tag)) !== -1) score += 10;
      });
    });

    // On évite de proposer des études HER2 si le parcours n'est pas HER2.
    var parcoursHER2 = resultTags.indexOf('her2') !== -1 || resultTags.indexOf('anti-her2') !== -1;
    var etudeHER2 = studyTags.indexOf('her2') !== -1 || studyTags.indexOf('anti-her2') !== -1 || studyTags.indexOf('HER2+') !== -1;
    if (etudeHER2 && !parcoursHER2) score = 0;

    return {
      valeur: Math.min(score, 100),
      tags: matched
    };
  }

  /* ════════════════════════════════════════════════════════════
     CHARGEMENT JSON
  ════════════════════════════════════════════════════════════ */

  function depth(node, d) {
    if (!node || node.type === 'resultat' || !node.choix) return d;
    var keys = Object.keys(node.choix), max = d;
    for (var i = 0; i < keys.length; i++) {
      var sub = depth(node.choix[keys[i]], d + 1);
      if (sub > max) max = sub;
    }
    return max;
  }

  function load() {
    var v = '?_v=' + Date.now();

    Promise.all([
      fetch('arbre_decision.json' + v).then(function (r) {
        if (!r.ok) throw new Error('arbre_decision.json HTTP ' + r.status);
        return r.json();
      }),
      fetch('base_etudes.json' + v).then(function (r) {
        if (!r.ok) throw new Error('base_etudes.json HTTP ' + r.status);
        return r.json();
      }).catch(function (err) {
        console.warn('[Atlas] base_etudes.json non disponible :', err.message);
        return null;
      })
    ]).then(function (results) {
      tree = results[0];
      maxDepth = depth(tree, 0) || 1;

      var base = results[1];
      if (Array.isArray(base)) {
        etudes = base;
      } else if (base && base.etudes) {
        etudes = base.etudes || [];
      } else {
        etudes = [];
      }

      console.log('[Atlas] Arbre chargé, profondeur :', maxDepth);
      console.log('[Atlas] Études chargées :', etudes.length);

      var bs = $('btn-start'), bh = $('btn-start-hero');
      if (bs) { bs.disabled = false; bs.textContent = 'Commencer →'; }
      if (bh) { bh.disabled = false; bh.textContent = 'Commencer l’évaluation →'; }
    }).catch(function (err) {
      console.error('[Atlas] Chargement :', err);
      alert('Impossible de charger les données.\nDétail : ' + err.message);
    });
  }

  /* ════════════════════════════════════════════════════════════
     NAVIGATION
  ════════════════════════════════════════════════════════════ */

  function show(id) {
    ['screen-home','screen-quiz','screen-results'].forEach(function (sid) {
      var el = $(sid);
      if (el) el.classList.toggle('active', sid === id);
    });
    window.scrollTo(0, 0);
  }

  function demarrer() {
    if (!tree) { alert('Données en cours de chargement. Réessayez.'); return; }
    history = [];
    current = tree;
    show('screen-quiz');
    render(current);
  }

  function reculer() {
    if (!history.length) return;
    var prev = history.pop();
    current = prev.node;
    render(current);
  }

  function recommencer() {
    history = [];
    current = null;
    ['quiz-choices','results-grid','results-path'].forEach(function (id) {
      var el = $(id);
      if (el) el.innerHTML = '';
    });
    var s = $('etudes-section');
    if (s) s.innerHTML = '';
    show('screen-home');
  }

  /* ════════════════════════════════════════════════════════════
     AFFICHAGE QUESTION
  ════════════════════════════════════════════════════════════ */

  function render(node) {
    if (node.type === 'resultat') {
      renderResults(node);
      return;
    }

    $('quiz-question').textContent = node.titre || '(Question sans titre)';

    var step = history.length + 1;
    var total = maxDepth || step;
    var pct = Math.round(Math.max(0, (step - 1) / total) * 100);

    $('quiz-step-label').textContent = 'Étape ' + step + ' / ' + total;
    $('quiz-pct-label').textContent = pct + ' %';
    $('quiz-progress-bar').style.width = pct + '%';
    $('btn-back').style.display = history.length > 0 ? 'inline-flex' : 'none';

    var container = $('quiz-choices');
    container.innerHTML = '';

    var keys = Object.keys(node.choix || {});
    if (!keys.length) {
      container.innerHTML = '<p style="color:#636e72;font-style:italic;">Aucune option disponible.</p>';
      return;
    }

    keys.forEach(function (label) {
      var next = node.choix[label];
      var btn = document.createElement('button');
      btn.className = 'choice-btn';

      var txt = document.createElement('span');
      txt.textContent = label;

      var arr = document.createElement('span');
      arr.className = 'arrow';
      arr.textContent = '→';
      arr.setAttribute('aria-hidden', 'true');

      btn.appendChild(txt);
      btn.appendChild(arr);

      btn.addEventListener('click', function () {
        history.push({ node: current, label: label });
        current = next;
        render(current);
      });

      container.appendChild(btn);
    });
  }

  /* ════════════════════════════════════════════════════════════
     RÉSULTATS SENORIF
  ════════════════════════════════════════════════════════════ */

  function cls(val) {
    var v = String(val || '').trim();
    if (v === '1' || v === '1.0') return 'rec';
    if (v === '0' || v === '0.0') return 'nrec';
    return 'ns';
  }

  function badge(val) {
    var v = String(val || '').trim();
    if (v === '1' || v === '1.0') return '✓ Recommandé';
    if (v === '0' || v === '0.0') return '✗ Non recommandé';
    return 'À discuter';
  }

  function renderResults(node) {
    var donnees = node.donnees || {};
    var sourceSenorif = sourceDuNoeud(node);

    $('quiz-progress-bar').style.width = '100%';
    $('quiz-pct-label').textContent = '100 %';
    $('quiz-step-label').textContent = 'Terminé';

    var pathEl = $('results-path');
    pathEl.innerHTML = '';

    if (!history.length) {
      pathEl.textContent = 'Résultat direct';
    } else {
      history.forEach(function (h, i) {
        if (i > 0) {
          var sep = document.createElement('span');
          sep.className = 'path-sep';
          sep.textContent = '›';
          pathEl.appendChild(sep);
        }
        var s = document.createElement('span');
        s.className = 'path-step';
        s.textContent = h.label;
        pathEl.appendChild(s);
      });
    }

    var grid = $('results-grid');
    grid.innerHTML = '';

    var sourceDiv = document.createElement('div');
    sourceDiv.style.cssText = 'grid-column:1/-1;margin-bottom:16px;font-size:13px;color:#636e72;display:flex;align-items:center;gap:8px;';
    sourceDiv.innerHTML = '<strong>📄 Source :</strong> ' + sourceSenorif;
    grid.appendChild(sourceDiv);

    var entries = Object.keys(donnees).map(function (k) {
      return { name: k.replace(/^OUT_/i, ''), val: donnees[k], cls: cls(donnees[k]) };
    });

    entries.sort(function (a, b) {
      return ({ rec: 0, ns: 1, nrec: 2 }[a.cls]) - ({ rec: 0, ns: 1, nrec: 2 }[b.cls]);
    });

    if (!entries.length) {
      grid.innerHTML += '<p style="color:#636e72;">Aucune donnée disponible.</p>';
    } else {
      entries.forEach(function (e) {
        var card = document.createElement('div');
        card.className = 'result-card ' + e.cls;

        var h4 = document.createElement('h4');
        h4.textContent = e.name;

        var b = document.createElement('span');
        b.className = 'badge ' + e.cls;
        b.textContent = badge(e.val);

        card.appendChild(h4);
        card.appendChild(b);
        grid.appendChild(card);
      });
    }

    show('screen-results');

    var traitements = extraireTraitementsRecommandes(donnees);
    var profilTexte = construireProfilTexte();
    renderEtudes(traitements, profilTexte);
  }

  /* ════════════════════════════════════════════════════════════
     ÉTUDES DE LA LITTÉRATURE — MATCHING STRICT PAR INDICATION
     Principe :
     1. On transforme le résultat du questionnaire en indications cliniques précises.
     2. Chaque étude possède aussi une liste "indications".
     3. On affiche uniquement les études dont l'indication correspond exactement.
  ════════════════════════════════════════════════════════════ */

  function indicationLabels() {
    return {
      "her2_adjuvant_trastuzumab": "HER2+ localisé — trastuzumab adjuvant",
      "her2_adjuvant_petites_tumeurs_n0_paclitaxel_trastuzumab": "HER2+ petite tumeur N0 — paclitaxel + trastuzumab",
      "her2_adjuvant_petites_tumeurs_n0_tdm1": "HER2+ petite tumeur N0 — T-DM1 adjuvant",
      "her2_adjuvant_pertuzumab_trastuzumab": "HER2+ adjuvant — pertuzumab + trastuzumab",
      "her2_post_neoadjuvant_residu_tdm1": "HER2+ post-néoadjuvant avec maladie résiduelle — T-DM1",
      "her2_adjuvant_etendu_neratinib": "HER2+ adjuvant étendu — neratinib après trastuzumab",
      "her2_adjuvant_duree_trastuzumab": "HER2+ adjuvant — durée du trastuzumab",
      "her2_neoadjuvant_double_blocage": "HER2+ néoadjuvant — double blocage trastuzumab + pertuzumab",
      "her2_metastatique_1l_pertuzumab_trastuzumab_docetaxel": "HER2+ métastatique 1re ligne — pertuzumab + trastuzumab + docétaxel",
      "her2_metastatique_ligne_ulterieure_tdm1": "HER2+ métastatique ligne ultérieure — T-DM1",
      "her2_metastatique_ligne_ulterieure_tdxd": "HER2+ métastatique ligne ultérieure — trastuzumab deruxtecan",
      "her2_metastatique_ligne_ulterieure_tucatinib": "HER2+ métastatique ligne ultérieure — tucatinib",
      "her2_metastatique_ligne_ulterieure_margetuximab": "HER2+ métastatique ligne ultérieure — margetuximab"
    };
  }

  function addUnique(arr, value) {
    if (arr.indexOf(value) === -1) arr.push(value);
  }

  function resultatVersIndications(traitements, profilTexte) {
    var indications = [];
    var all = normaliser(traitements.join(' ') + ' ' + profilTexte);

    var isHER2 = all.indexOf('her2') !== -1 || all.indexOf('anti her2') !== -1 ||
                 all.indexOf('trastuzumab') !== -1 || all.indexOf('pertuzumab') !== -1 ||
                 all.indexOf('t dm1') !== -1 || all.indexOf('tdm1') !== -1;

    if (!isHER2) return indications;

    var isMeta = all.indexOf('metastatique') !== -1 || all.indexOf('metastase') !== -1;
    var isFirstLineMeta = isMeta && (
      all.indexOf('premier traitement') !== -1 ||
      all.indexOf('1l') !== -1 ||
      all.indexOf('1ere ligne') !== -1 ||
      all.indexOf('premiere ligne') !== -1
    );
    var isLaterLineMeta = isMeta && (
      all.indexOf('progression') !== -1 ||
      all.indexOf('ligne ulterieure') !== -1 ||
      all.indexOf('apres progression') !== -1 ||
      !isFirstLineMeta
    );

    var isNeo = all.indexOf('neoadjuvant') !== -1 ||
                all.indexOf('avant la chirurgie') !== -1 ||
                all.indexOf('traitement avant chirurgie') !== -1;

    var hasResidual = all.indexOf('rcb i') !== -1 ||
                      all.indexOf('rcb ii') !== -1 ||
                      all.indexOf('rcb iii') !== -1 ||
                      all.indexOf('residu') !== -1 ||
                      all.indexOf('maladie residuelle') !== -1;

    var hasPCR = all.indexOf('rcb 0') !== -1 || all.indexOf('pcr') !== -1;

    var hasTDm1 = all.indexOf('t dm1') !== -1 || all.indexOf('tdm1') !== -1;
    var hasTDxd = all.indexOf('t dxd') !== -1 || all.indexOf('deruxtecan') !== -1;
    var hasTucatinib = all.indexOf('tucatinib') !== -1;
    var hasMargetuximab = all.indexOf('margetuximab') !== -1;
    var hasPertuzumab = all.indexOf('pertuzumab') !== -1;
    var hasTrastuzumab = all.indexOf('trastuzumab') !== -1;
    var hasPaclitaxel = all.indexOf('paclitaxel') !== -1;
    var hasNeratinib = all.indexOf('neratinib') !== -1;

    if (isMeta) {
      if (isFirstLineMeta && (hasPertuzumab || hasTrastuzumab || all.indexOf('anti her2 1l') !== -1)) {
        addUnique(indications, "her2_metastatique_1l_pertuzumab_trastuzumab_docetaxel");
      }
      if (isLaterLineMeta && hasTDm1) addUnique(indications, "her2_metastatique_ligne_ulterieure_tdm1");
      if (isLaterLineMeta && hasTDxd) addUnique(indications, "her2_metastatique_ligne_ulterieure_tdxd");
      if (isLaterLineMeta && hasTucatinib) addUnique(indications, "her2_metastatique_ligne_ulterieure_tucatinib");
      if (isLaterLineMeta && hasMargetuximab) addUnique(indications, "her2_metastatique_ligne_ulterieure_margetuximab");

      // Si le résultat dit seulement "anti-HER2 ligne ultérieure", on évite de choisir un seul médicament :
      // on affiche les familles principales de preuves ligne ultérieure.
      if (isLaterLineMeta && all.indexOf('anti her2 ligne ulterieure') !== -1) {
        addUnique(indications, "her2_metastatique_ligne_ulterieure_tdm1");
        addUnique(indications, "her2_metastatique_ligne_ulterieure_tdxd");
        addUnique(indications, "her2_metastatique_ligne_ulterieure_tucatinib");
      }

      return indications;
    }

    // Situation post-néoadjuvante HER2+.
    if ((isNeo || hasResidual || hasPCR) && hasTDm1) {
      addUnique(indications, "her2_post_neoadjuvant_residu_tdm1");
      return indications;
    }

    if ((isNeo || hasPCR) && hasPCR && hasTrastuzumab) {
      addUnique(indications, "her2_adjuvant_trastuzumab");
      if (hasPertuzumab) addUnique(indications, "her2_adjuvant_pertuzumab_trastuzumab");
      return indications;
    }

    // Néoadjuvant double blocage.
    if (isNeo && hasPertuzumab && hasTrastuzumab) {
      addUnique(indications, "her2_neoadjuvant_double_blocage");
      return indications;
    }

    // Petite tumeur N0 avec paclitaxel-trastuzumab.
    if (hasPaclitaxel && hasTrastuzumab) {
      addUnique(indications, "her2_adjuvant_petites_tumeurs_n0_paclitaxel_trastuzumab");
      return indications;
    }

    if (hasNeratinib) {
      addUnique(indications, "her2_adjuvant_etendu_neratinib");
      return indications;
    }

    // Adjuvant HER2+ standard.
    if (hasPertuzumab && hasTrastuzumab) {
      addUnique(indications, "her2_adjuvant_pertuzumab_trastuzumab");
      addUnique(indications, "her2_adjuvant_trastuzumab");
      return indications;
    }

    if (hasTrastuzumab || all.indexOf('anti her2') !== -1) {
      addUnique(indications, "her2_adjuvant_trastuzumab");
      return indications;
    }

    return indications;
  }

  function etudeCorrespondAuxIndications(etude, indicationsResultat) {
    var inds = etude.indications || [];
    var matched = [];
    inds.forEach(function(ind) {
      if (indicationsResultat.indexOf(ind) !== -1) matched.push(ind);
    });
    return matched;
  }

  function renderEtudes(traitementsRecommandes, profilTexte) {
    var section = $('etudes-section');
    if (!section) return;
    section.innerHTML = '';

    var h3 = document.createElement('h3');
    h3.textContent = 'Données issues de la littérature';
    h3.style.cssText = 'font-size:18px;font-weight:700;margin:32px 0 8px;';
    section.appendChild(h3);

    if (!etudes || !etudes.length) {
      section.innerHTML += '<p style="color:#636e72;font-size:13px;margin-top:12px;">Aucune étude disponible.</p>';
      return;
    }

    var indicationsResultat = resultatVersIndications(traitementsRecommandes, profilTexte);
    var labels = indicationLabels();

    if (!indicationsResultat.length) {
      var p0 = document.createElement('p');
      p0.style.cssText = 'color:#636e72;font-size:13px;margin-top:12px;';
      p0.textContent = 'Aucune indication d’étude codée pour ce résultat. Il faut ajouter des études ou une règle de correspondance pour ce traitement.';
      section.appendChild(p0);
      return;
    }

    var intro = document.createElement('p');
    intro.style.cssText = 'color:#636e72;font-size:13px;margin:8px 0 16px;';
    intro.innerHTML = '<strong>Indication utilisée pour sélectionner les études :</strong> ' +
      indicationsResultat.map(function(ind){ return labels[ind] || ind; }).join(' · ');
    section.appendChild(intro);

    var matched = etudes.map(function(e) {
      return {
        etude: e,
        indications: etudeCorrespondAuxIndications(e, indicationsResultat)
      };
    }).filter(function(x) {
      return x.indications.length > 0;
    }).sort(function(a, b) {
      return niveauRank(b.etude.niveau_preuve) - niveauRank(a.etude.niveau_preuve);
    });

    if (!matched.length) {
      var p = document.createElement('p');
      p.style.cssText = 'color:#636e72;font-size:13px;margin-top:12px;';
      p.textContent = 'Aucune étude de la base ne correspond à cette indication précise.';
      section.appendChild(p);
      return;
    }

    matched.forEach(function(item) {
      section.appendChild(creerCarteEtude(item.etude, item.indications));
    });
  }

  function niveauRank(niveau) {
    var n = String(niveau || '').toUpperCase().trim();
    if (n === 'A') return 4;
    if (n === 'B') return 3;
    if (n === 'C') return 2;
    if (n === 'D') return 1;
    return 0;
  }

  function creerCarteEtude(etude, indications) {
    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin-bottom:14px;';

    var titre = (etude.auteur || etude.reference || etude.titre || 'Étude') +
      (etude.date ? ' (' + etude.date + ')' : '');

    var niveau = etude.niveau_preuve || 'Non précisé';
    var lien = etude.lien || '';
    var labels = indicationLabels();

    var html =
      '<div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;">' +
        '<div style="flex:1;">' +
          '<h4 style="margin:0 0 8px 0;font-size:16px;color:#1a1a1a;">' + escapeHtml(titre) + '</h4>' +
          '<div style="font-size:13px;color:#636e72;margin-bottom:8px;">' +
            '<strong>Niveau de preuve :</strong> ' + escapeHtml(niveau) +
          '</div>' +
          (indications && indications.length ? '<div style="font-size:12px;color:#636e72;margin-bottom:10px;">Correspond à : ' + escapeHtml(indications.map(function(ind){ return labels[ind] || ind; }).join(', ')) + '</div>' : '') +
          (etude.objectif ? '<div style="font-size:13px;color:#374151;margin:10px 0;">' + escapeHtml(etude.objectif) + '</div>' : '') +
          (lien ? '<a href="' + escapeAttr(lien) + '" target="_blank" rel="noopener" style="font-size:13px;color:#2563eb;text-decoration:none;font-weight:600;">Voir l’étude →</a>' : '') +
        '</div>' +
      '</div>';

    card.innerHTML = html;
    return card;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/`/g, '&#096;');
  }

  /* ════════════════════════════════════════════════════════════
     EXPOSITION GLOBALE
  ════════════════════════════════════════════════════════════ */

  window.demarrer = demarrer;
  window.reculer = reculer;
  window.recommencer = recommencer;
  window.accueil = recommencer;

  load();

}());
