import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ts = createRequire(new URL("../package.json", import.meta.url))("typescript");
function productionClass(file, className, methods, context) {
    const ast = ts.createSourceFile(file, readFileSync(new URL("../src/pipedal/" + file, import.meta.url), "utf8"),
        ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let declaration;
    const visit = node => {
        if (ts.isClassDeclaration(node) && node.name?.text === className) declaration = node;
        else ts.forEachChild(node, visit);
    };
    visit(ast); assert.ok(declaration);
    const selected = declaration.members.filter(node => methods.includes(node.name?.getText(ast)));
    assert.equal(selected.length, methods.length);
    const code = "class Subject extends Base {" + selected.map(node => node.getText(ast)).join("\n") + "}\nglobalThis.Subject = Subject;";
    vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return new context.Subject();
}

/** Run production registration and cleanup against the actual model close method.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [DES-LANDSCAPE] [7.38]
 */
function fixture() {
    class Base { componentDidMount() {} componentWillUnmount() {} }
    const listeners = new Map(); let closes = 0;
    const socket = { close: () => ++closes };
    const model = productionClass("PiPedalModel.tsx", "PiPedalModel", ["close"], { Base });
    model.isClosed = false; model.webSocket = socket;
    for (const name of ["zoomedUiControl", "errorMessage", "state", "pedalboard", "alertMessage", "banks", "showStatusMonitor", "promptForUpdate"])
        model[name] = { addOnChangedHandler() {}, removeOnChangedHandler() {} };
    const app = productionClass("AppThemed.tsx", "AppThemedBase", ["pageHideListener", "componentDidMount", "componentWillUnmount"], {
        Base, window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name, fn) => {
            assert.equal(listeners.get(name), fn); listeners.delete(name);
        } }, alert: () => assert.fail("navigation must never display the old debug alert")
    });
    app.model_ = model; app.pageHideListener = app.pageHideListener.bind(app); app.alertMessageChangedHandler = () => {};
    app.componentDidMount();
    return { app, model, socket, listeners, closes: () => closes, dispatch: (name, persisted = false) => listeners.get(name)?.({ persisted }) };
}

test("canceled navigation and persisted pagehide keep the real browser model usable", () => {
    const f = fixture();
    assert.equal(f.listeners.has("beforeunload"), false);
    f.dispatch("beforeunload"); f.dispatch("pagehide", true);
    assert.equal(f.model.isClosed, false); assert.equal(f.model.webSocket, f.socket); assert.equal(f.closes(), 0);
    f.dispatch("pagehide", false); f.dispatch("pagehide", false);
    assert.equal(f.model.isClosed, true); assert.equal(f.model.webSocket, undefined); assert.equal(f.closes(), 1);
});

test("unmount removes the committed-navigation listener and closes the model once", () => {
    const f = fixture(); f.app.componentWillUnmount();
    assert.equal(f.listeners.size, 0); assert.equal(f.closes(), 1);
    f.dispatch("pagehide"); assert.equal(f.closes(), 1);
});
