// admin-app.jsx — BuhlOS Admin. Sidebar router across the full live surface,
// with a job-hub deep-link channel and the Tweaks panel.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "density": "regular",
  "day": "busy"
}/*EDITMODE-END*/;

function AdminApp() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = React.useState(() => localStorage.getItem("bx-route") || "cc");
  const [openJobId, setOpenJobId] = React.useState(null);
  const [buildId, setBuildId] = React.useState(null);
  React.useEffect(() => { localStorage.setItem("bx-route", route); }, [route]);

  // sidebar / cross-screen nav — resets any open job
  const go = (k) => { setOpenJobId(null); setRoute(k); };
  // deep-link into a specific job hub from anywhere
  const openJob = (id) => { if (!id) return; setOpenJobId(id); setRoute("jobs"); };
  const setOpenJob = (id) => setOpenJobId(id);
  // open the Job Builder cockpit (full-screen overlay)
  const openBuilder = (id) => setBuildId(id || openJobId || "P25-014");

  const Page = {
    cc:      <CommandCentre setRoute={go} openJob={openJob} dayState={t.day} />,
    jobs:    <JobsPage openJobId={openJobId} setOpenJob={setOpenJob} openBuilder={openBuilder} />,
    hours:   <HoursPage />,
    defects: <DefectsPage setOpenJob={openJob} />,
    obs:     <ObservationsPage setOpenJob={openJob} />,
    mats:    <MaterialsPage />,
    exp:     <ExpensesPage />,
    daywork: <DayworksPage setOpenJob={openJob} />,
    people:  <PeoplePage />,
    gear:    <GearPage />,
    quotes:  <QuotesPage />,
    reports: <ReportsPage setRoute={go} setOpenJob={openJob} />,
    qa:      <QaPage setOpenJob={openJob} />,
    itp:     <ItpTemplatesPage />,
    settings:<SettingsPage />,
  }[route] || <CommandCentre setRoute={go} openJob={openJob} dayState={t.day} />;

  const fontSize = t.density === "compact" ? 12 : t.density === "comfy" ? 14 : 13;

  return (
    <div className="screen" data-theme={t.theme} style={{ fontSize }}>
      <div className="bos">
        <Sidebar route={route} setRoute={go} />
        <div className="bos-main">
          <Topbar route={route} setRoute={go} openJob={openJob} />
          <div className="bos-content" key={route + (openJobId || "")}>
            {Page}
          </div>
        </div>
      </div>

      {buildId && <BuilderCockpit jobId={buildId} onClose={() => setBuildId(null)} />}

      <TweaksPanel title="Tweaks">
        <TweakSection label="Appearance" />
        <TweakRadio label="Theme" value={t.theme}
          options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "hc", label: "HC" }]}
          onChange={(v) => setTweak("theme", v)} />
        <TweakRadio label="Density" value={t.density}
          options={[{ value: "compact", label: "Compact" }, { value: "regular", label: "Regular" }, { value: "comfy", label: "Comfy" }]}
          onChange={(v) => setTweak("density", v)} />
        <TweakSection label="Demo" />
        <TweakRadio label="Day state" value={t.day}
          options={[{ value: "quiet", label: "Calm" }, { value: "busy", label: "Busy" }, { value: "fire", label: "On fire" }]}
          onChange={(v) => setTweak("day", v)} />
        <div className="twk-hint">Reshapes the Command Centre — the same desk on a quiet day and a day on fire.</div>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<AdminApp />);
