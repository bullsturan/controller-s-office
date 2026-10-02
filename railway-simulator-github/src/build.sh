python3 - <<'PY'
s=open('shell.html').read()
strip=lambda t: t.replace("if (typeof module !== 'undefined') module.exports","//")
s=s.replace('/*I18N*/',open('i18n.js').read()).replace('/*SIM*/',strip(open('sim.js').read())).replace('/*SCEN*/',strip(open('scen.js').read())).replace('/*UI*/',open('ui.js').read())
open('/mnt/user-data/outputs/rail-sim.html','w').write(s)
PY
