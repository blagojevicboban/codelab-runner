// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

import com.sun.jdi.AbsentInformationException;
import com.sun.jdi.ArrayReference;
import com.sun.jdi.BooleanValue;
import com.sun.jdi.Bootstrap;
import com.sun.jdi.CharValue;
import com.sun.jdi.ClassType;
import com.sun.jdi.Field;
import com.sun.jdi.IncompatibleThreadStateException;
import com.sun.jdi.LocalVariable;
import com.sun.jdi.Location;
import com.sun.jdi.Method;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.PrimitiveValue;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.StackFrame;
import com.sun.jdi.StringReference;
import com.sun.jdi.ThreadReference;
import com.sun.jdi.Value;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.connect.LaunchingConnector;
import com.sun.jdi.event.BreakpointEvent;
import com.sun.jdi.event.ClassPrepareEvent;
import com.sun.jdi.event.Event;
import com.sun.jdi.event.EventSet;
import com.sun.jdi.event.LocatableEvent;
import com.sun.jdi.event.StepEvent;
import com.sun.jdi.event.VMDeathEvent;
import com.sun.jdi.event.VMDisconnectEvent;
import com.sun.jdi.event.VMStartEvent;
import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.ClassPrepareRequest;
import com.sun.jdi.request.EventRequest;
import com.sun.jdi.request.EventRequestManager;
import com.sun.jdi.request.StepRequest;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Step for Java in the CodeLab runner: a debugger on the Java Debug Interface that speaks the part of gdb's machine
 * interface (MI) the runner uses for C and C++, so lib/session.js drives it the same way. It launches the program
 * (java -cp /box Main) suspended, gives it /box/in.fifo, /box/out.fifo and /box/err.fifo, and answers on stdin and
 * stdout:
 *   -break-insert [-t] [-c "condition"] File.java:line | -break-insert -t main,  -break-delete n...,
 *   -exec-run, -exec-step, -exec-next, -exec-finish, -exec-continue,
 *   -stack-list-frames, -stack-list-variables --frame n, -data-evaluate-expression --frame n "expression", -gdb-exit
 * with ^done / ^error / ^running results and *stopped records (reason breakpoint-hit, end-stepping-range or exited with
 * a decimal exit-code). Steps stay in the program's own classes (the JDK's are filtered). Values are shown in gdb's
 * notation: arrays and lists {3, 1, 2}, maps {["Ana"] = 16}, objects {value = 1, next = {Node}}. Conditions and
 * watches are small Java expressions (variables, fields, array elements, method calls, arithmetic, comparisons,
 * logic). Built by the runner with javac (module jdk.jdi), run in its sandbox.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
public final class JavaDebugger {
    /** Classes of the JDK: never stepped into, never shown in the call stack. */
    private static final String[] LIBRARY = {"java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*"};
    private static final int MAX_ITEMS = 30;
    private static final int MAX_FIELDS = 12;
    private static final int MAX_TEXT = 300;

    private final PrintStream mi;
    private final String mainClass;
    private final String box;
    private VirtualMachine vm;
    private Process process;
    private ThreadReference thread;
    private final List<Thread> pumps = new ArrayList<>();
    private final Map<Integer, Breakpoint> breakpoints = new LinkedHashMap<>();
    private int nextBreakpoint = 1;
    private volatile boolean ended;

    /** A breakpoint of the student: its requests in the loaded classes, its condition, whether it is temporary. */
    private static final class Breakpoint {
        final String file;
        final int line;
        final String condition;
        final boolean temporary;
        final boolean main;
        final List<BreakpointRequest> requests = new ArrayList<>();

        Breakpoint(String file, int line, String condition, boolean temporary, boolean main) {
            this.file = file;
            this.line = line;
            this.condition = condition;
            this.temporary = temporary;
            this.main = main;
        }
    }

    private JavaDebugger(String mainClass, String box) {
        this.mi = new PrintStream(new FileOutputStream(java.io.FileDescriptor.out), true, StandardCharsets.UTF_8);
        this.mainClass = mainClass;
        this.box = box;
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: JavaDebugger MainClass [box folder] [options of the program's JVM]");
            System.exit(2);
        }
        String box = args.length > 1 ? args[1] : "/box";
        String options = args.length > 2 ? args[2] : "";
        JavaDebugger debugger = new JavaDebugger(args[0], box);
        debugger.launch(options);
        debugger.commands();
    }

    // ------------------------------------------------------------------ launching

    private void launch(String options) throws Exception {
        LaunchingConnector connector = Bootstrap.virtualMachineManager().defaultConnector();
        Map<String, Connector.Argument> arguments = connector.defaultArguments();
        arguments.get("main").setValue("-cp " + box + " " + mainClass);
        arguments.get("options").setValue(options);
        arguments.get("suspend").setValue("true");
        vm = connector.launch(arguments);
        process = vm.process();
        pump(new FileInputStream(box + "/in.fifo"), process.getOutputStream(), true);
        pump(process.getInputStream(), new FileOutputStream(box + "/out.fifo"), false);
        pump(process.getErrorStream(), new FileOutputStream(box + "/err.fifo"), false);
        EventRequestManager manager = vm.eventRequestManager();
        ClassPrepareRequest prepare = manager.createClassPrepareRequest();
        for (String library : LIBRARY) {
            prepare.addClassExclusionFilter(library);
        }
        prepare.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        prepare.enable();
        Thread events = new Thread(this::events, "events");
        events.setDaemon(true);
        events.start();
    }

    /** Copy a stream to another until its end (the program's input, output and errors). */
    private void pump(InputStream from, OutputStream to, boolean input) {
        Thread t = new Thread(() -> {
            byte[] buffer = new byte[8192];
            try {
                int n;
                while ((n = from.read(buffer)) >= 0) {
                    to.write(buffer, 0, n);
                    to.flush();
                }
            } catch (Exception e) {
                // The program or the session ended.
            } finally {
                try {
                    to.close();
                } catch (Exception e) {
                    // Closed already.
                }
            }
        }, input ? "stdin" : "output");
        t.setDaemon(true);
        t.start();
        if (!input) {
            pumps.add(t);
        }
    }

    // ------------------------------------------------------------------ events of the program

    private void events() {
        try {
            while (!ended) {
                EventSet set = vm.eventQueue().remove();
                boolean resume = true;
                for (Event event : set) {
                    if (event instanceof VMStartEvent) {
                        // The program waits for -exec-run (and the breakpoints set before it).
                        resume = false;
                    } else if (event instanceof ClassPrepareEvent prepared) {
                        resolve(prepared.referenceType());
                    } else if (event instanceof BreakpointEvent hit) {
                        resume &= !breakpointHit(hit);
                    } else if (event instanceof StepEvent step) {
                        vm.eventRequestManager().deleteEventRequest(step.request());
                        stopped("end-stepping-range", step);
                        resume = false;
                    } else if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) {
                        exited();
                        return;
                    }
                }
                if (resume) {
                    set.resume();
                }
            }
        } catch (InterruptedException e) {
            // Ending.
        } catch (com.sun.jdi.VMDisconnectedException e) {
            exited();
        }
    }

    /** A breakpoint was reached: whether the program stops (its condition holds). */
    private boolean breakpointHit(BreakpointEvent hit) {
        Breakpoint bp = null;
        for (Breakpoint b : breakpoints.values()) {
            if (b.requests.contains(hit.request())) {
                bp = b;
            }
        }
        if (bp == null) {
            return false;
        }
        if (!bp.condition.isEmpty()) {
            try {
                Object value = new Expression(bp.condition, hit.thread(), 0).evaluate();
                if (!(value instanceof Boolean b) || !b) {
                    return false;
                }
            } catch (Exception e) {
                // A condition that cannot be evaluated stops, so the student sees where.
            }
        }
        if (bp.temporary) {
            remove(bp);
        }
        stopped("breakpoint-hit", hit);
        return true;
    }

    private synchronized void exited() {
        if (ended) {
            return;
        }
        ended = true;
        int code = 0;
        try {
            code = process.waitFor();
        } catch (InterruptedException e) {
            // Ending anyway.
        }
        for (Thread t : pumps) {
            try {
                t.join(2000);
            } catch (InterruptedException e) {
                // Ending anyway.
            }
        }
        mi.println("*stopped,reason=\"exited\",exit-code=\"" + code + "\"");
    }

    private void stopped(String reason, LocatableEvent event) {
        thread = event.thread();
        Location where = event.location();
        mi.println("*stopped,reason=\"" + reason + "\",thread-id=\"" + thread.uniqueID() + "\",frame=" + frame(where, -1));
    }

    // ------------------------------------------------------------------ breakpoints

    /** Set the breakpoints of the student in a class that was just loaded. */
    private synchronized void resolve(ReferenceType type) {
        for (Breakpoint bp : breakpoints.values()) {
            place(bp, type);
        }
    }

    private void place(Breakpoint bp, ReferenceType type) {
        try {
            List<Location> locations;
            if (bp.main) {
                if (!type.name().equals(mainClass)) {
                    return;
                }
                locations = new ArrayList<>();
                for (Method m : type.methodsByName("main")) {
                    if (m.isStatic() && m.location() != null) {
                        locations.add(m.location());
                    }
                }
            } else {
                if (!bp.file.equals(type.sourceName())) {
                    return;
                }
                locations = type.locationsOfLine(bp.line);
            }
            for (Location location : locations) {
                BreakpointRequest request = vm.eventRequestManager().createBreakpointRequest(location);
                request.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                request.enable();
                bp.requests.add(request);
            }
        } catch (AbsentInformationException e) {
            // A class without its source: not the student's.
        }
    }

    private synchronized String breakInsert(List<String> args) {
        boolean temporary = false;
        String condition = "";
        String where = "";
        for (int i = 0; i < args.size(); i++) {
            String a = args.get(i);
            if (a.equals("-t")) {
                temporary = true;
            } else if (a.equals("-c") && i + 1 < args.size()) {
                condition = args.get(++i);
            } else {
                where = a;
            }
        }
        Breakpoint bp;
        if (where.equals("main")) {
            bp = new Breakpoint("", 0, condition, temporary, true);
        } else {
            int colon = where.lastIndexOf(':');
            if (colon < 0) {
                return "^error,msg=\"No file and line.\"";
            }
            String file = where.substring(0, colon);
            file = file.substring(file.lastIndexOf('/') + 1);
            int line;
            try {
                line = Integer.parseInt(where.substring(colon + 1));
            } catch (NumberFormatException e) {
                return "^error,msg=\"No line.\"";
            }
            bp = new Breakpoint(file, line, condition, temporary, false);
        }
        int number = nextBreakpoint++;
        breakpoints.put(number, bp);
        for (ReferenceType type : vm.allClasses()) {
            if (!library(type.name())) {
                place(bp, type);
            }
        }
        return "^done,bkpt={number=\"" + number + "\",type=\"breakpoint\",disp=\"" + (temporary ? "del" : "keep")
            + "\",enabled=\"y\"}";
    }

    private synchronized void remove(Breakpoint bp) {
        for (BreakpointRequest request : bp.requests) {
            vm.eventRequestManager().deleteEventRequest(request);
        }
        bp.requests.clear();
        breakpoints.values().remove(bp);
    }

    // ------------------------------------------------------------------ commands of the runner

    private void commands() throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            int i = 0;
            while (i < line.length() && Character.isDigit(line.charAt(i))) {
                i++;
            }
            String token = line.substring(0, i);
            List<String> words = split(line.substring(i).trim());
            if (words.isEmpty()) {
                continue;
            }
            String command = words.remove(0);
            String result;
            try {
                result = run(command, words);
            } catch (Exception e) {
                result = "^error,msg=\"" + escape(String.valueOf(e.getMessage())) + "\"";
            }
            mi.println(token + result);
            if (command.equals("-gdb-exit")) {
                break;
            }
        }
        if (!ended && vm != null) {
            try {
                vm.exit(1);
            } catch (Exception e) {
                // Gone already.
            }
        }
        if (process != null) {
            process.destroyForcibly();
        }
        System.exit(0);
    }

    private String run(String command, List<String> args) throws Exception {
        switch (command) {
            case "-break-insert":
                return breakInsert(args);
            case "-break-delete":
                for (String a : args) {
                    Breakpoint bp = breakpoints.get(Integer.parseInt(a));
                    if (bp != null) {
                        remove(bp);
                    }
                }
                return "^done";
            case "-exec-run":
                vm.resume();
                return "^running";
            case "-exec-continue":
                if (!ended) {
                    vm.resume();
                }
                return "^running";
            case "-exec-step":
                return step(StepRequest.STEP_INTO);
            case "-exec-next":
                return step(StepRequest.STEP_OVER);
            case "-exec-finish":
                return step(StepRequest.STEP_OUT);
            case "-stack-list-frames":
                return stackFrames();
            case "-stack-list-variables":
                return variables(frameOption(args));
            case "-data-evaluate-expression":
                return evaluate(frameOption(args), args.isEmpty() ? "" : args.get(args.size() - 1));
            case "-gdb-exit":
                return "^exit";
            default:
                return "^done";
        }
    }

    private String step(int depth) {
        if (ended || thread == null) {
            return "^error,msg=\"The program is not paused.\"";
        }
        EventRequestManager manager = vm.eventRequestManager();
        for (StepRequest old : new ArrayList<>(manager.stepRequests())) {
            manager.deleteEventRequest(old);
        }
        StepRequest request = manager.createStepRequest(thread, StepRequest.STEP_LINE, depth);
        for (String library : LIBRARY) {
            request.addClassExclusionFilter(library);
        }
        request.addCountFilter(1);
        request.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        request.enable();
        vm.resume();
        return "^running";
    }

    /** The --frame option of a command (0: the innermost frame). */
    private static int frameOption(List<String> args) {
        int frame = 0;
        for (int i = 0; i < args.size(); i++) {
            if (args.get(i).equals("--frame") && i + 1 < args.size()) {
                frame = Integer.parseInt(args.get(i + 1));
                args.remove(i + 1);
                args.remove(i);
                i--;
            } else if (args.get(i).equals("--thread") && i + 1 < args.size()) {
                args.remove(i + 1);
                args.remove(i);
                i--;
            } else if (args.get(i).startsWith("--")) {
                args.remove(i);
                i--;
            }
        }
        return frame;
    }

    private String stackFrames() throws IncompatibleThreadStateException {
        if (thread == null) {
            return "^error,msg=\"The program is not paused.\"";
        }
        StringBuilder out = new StringBuilder("^done,stack=[");
        List<StackFrame> frames = thread.frames();
        boolean first = true;
        for (int level = 0; level < frames.size(); level++) {
            Location where = frames.get(level).location();
            if (!own(where)) {
                continue;
            }
            out.append(first ? "" : ",").append("frame=").append(frame(where, level));
            first = false;
        }
        return out.append("]").toString();
    }

    private String variables(int level) throws Exception {
        StackFrame frame = thread.frame(level);
        StringBuilder out = new StringBuilder("^done,variables=[");
        List<String[]> list = new ArrayList<>();
        ObjectReference self = frame.thisObject();
        if (self != null) {
            list.add(new String[] {"this", show(self, 0)});
        }
        try {
            List<LocalVariable> locals = frame.visibleVariables();
            Map<LocalVariable, Value> values = frame.getValues(locals);
            for (LocalVariable v : locals) {
                list.add(new String[] {v.name(), show(values.get(v), 0)});
                frame = thread.frame(level);
            }
        } catch (AbsentInformationException e) {
            // Compiled without -g: no local variables.
        }
        for (int i = 0; i < list.size(); i++) {
            out.append(i == 0 ? "" : ",").append("{name=\"").append(escape(list.get(i)[0])).append("\",value=\"")
                .append(escape(cut(list.get(i)[1]))).append("\"}");
        }
        return out.append("]").toString();
    }

    private String evaluate(int level, String expression) {
        try {
            Object value = new Expression(expression, thread, level).evaluate();
            return "^done,value=\"" + escape(cut(text(value))) + "\"";
        } catch (Exception e) {
            return "^error,msg=\"" + escape(String.valueOf(e.getMessage())) + "\"";
        }
    }

    // ------------------------------------------------------------------ frames and their places

    private boolean own(Location where) {
        if (where == null || library(where.declaringType().name())) {
            return false;
        }
        try {
            return new File(box, where.sourceName()).isFile();
        } catch (AbsentInformationException e) {
            return false;
        }
    }

    private static boolean library(String name) {
        return name.startsWith("java.") || name.startsWith("javax.") || name.startsWith("jdk.") || name.startsWith("sun.")
            || name.startsWith("com.sun.");
    }

    private String frame(Location where, int level) {
        String source;
        try {
            source = where.sourceName();
        } catch (AbsentInformationException e) {
            source = "";
        }
        return "{" + (level >= 0 ? "level=\"" + level + "\"," : "") + "func=\"" + escape(methodName(where.method()))
            + "\",file=\"" + escape(source) + "\",fullname=\"" + escape(box + "/" + source) + "\",line=\""
            + where.lineNumber() + "\"}";
    }

    /** fact, main; a constructor by its class (Node). */
    private static String methodName(Method method) {
        if (method.isConstructor()) {
            String name = method.declaringType().name();
            return name.substring(Math.max(name.lastIndexOf('.'), name.lastIndexOf('$')) + 1);
        }
        return method.name();
    }

    // ------------------------------------------------------------------ values in gdb's notation

    private static String simpleName(String type) {
        String name = type.substring(type.lastIndexOf('.') + 1);
        return name.substring(name.lastIndexOf('$') + 1);
    }

    private static String cut(String text) {
        return text.length() > MAX_TEXT ? text.substring(0, MAX_TEXT) : text;
    }

    private static String braces(List<String> items, int total) {
        return "{" + String.join(", ", items) + (total > items.size() ? ", ..." : "") + "}";
    }

    private static String quote(String s) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\t' -> out.append("\\t");
                case '\r' -> out.append("\\r");
                default -> out.append(c);
            }
            if (out.length() > MAX_TEXT) {
                out.append("...");
                break;
            }
        }
        return out.append('"').toString();
    }

    /** A value of the program as text: computed values of expressions too. */
    private String text(Object value) {
        if (value instanceof Value v) {
            return show(v, 0);
        }
        if (value instanceof String s) {
            return quote(s);
        }
        if (value instanceof Character c) {
            return "'" + c + "'";
        }
        if (value instanceof Double d && d == Math.rint(d) && !Double.isInfinite(d)) {
            return String.valueOf(d);
        }
        return String.valueOf(value);
    }

    private String show(Value value, int depth) {
        if (value == null) {
            return "null";
        }
        if (value instanceof CharValue c) {
            return "'" + c.value() + "'";
        }
        if (value instanceof PrimitiveValue) {
            return value.toString();
        }
        if (value instanceof StringReference s) {
            return quote(s.value());
        }
        if (value instanceof ArrayReference array) {
            if (depth > 1) {
                return "{" + simpleName(array.referenceType().name()).replace("[]", "[" + array.length() + "]") + "}";
            }
            List<String> items = new ArrayList<>();
            List<Value> values = array.getValues(0, Math.min(array.length(), MAX_ITEMS));
            for (Value v : values) {
                items.add(show(v, depth + 1));
            }
            return braces(items, array.length());
        }
        ObjectReference object = (ObjectReference) value;
        String type = object.referenceType().name();
        Value boxed = boxedValue(object);
        if (boxed != null) {
            return show(boxed, depth);
        }
        if (depth > 1) {
            return "{" + simpleName(type) + "}";
        }
        try {
            if (library(type)) {
                // Collections, maps and text builders with their contents; other classes of the JDK by their name.
                String library = libraryValue(object, depth);
                return library != null ? library : "{" + simpleName(type) + "}";
            }
        } catch (Exception e) {
            return "{" + simpleName(type) + "}";
        }
        if (depth > 0) {
            return "{" + simpleName(type) + "}";
        }
        List<String> fields = new ArrayList<>();
        int total = 0;
        for (Field f : object.referenceType().allFields()) {
            if (f.isStatic() || f.isSynthetic()) {
                continue;
            }
            total++;
            if (fields.size() < MAX_FIELDS) {
                fields.add(f.name() + " = " + show(object.getValue(f), depth + 1));
            }
        }
        return fields.isEmpty() ? "{" + simpleName(type) + "}" : braces(fields, total);
    }

    /** The value of an Integer, Double, Character... */
    private static Value boxedValue(ObjectReference object) {
        String type = object.referenceType().name();
        if (type.equals("java.lang.Integer") || type.equals("java.lang.Long") || type.equals("java.lang.Double")
                || type.equals("java.lang.Float") || type.equals("java.lang.Short") || type.equals("java.lang.Byte")
                || type.equals("java.lang.Character") || type.equals("java.lang.Boolean")) {
            Field f = object.referenceType().fieldByName("value");
            return f == null ? null : object.getValue(f);
        }
        return null;
    }

    /** Collections, maps and text builders of the JDK, through their own methods (the program is paused). */
    private String libraryValue(ObjectReference object, int depth) throws Exception {
        if (thread == null) {
            return null;
        }
        if (implementsType(object, "java.lang.CharSequence")) {
            Value s = invoke(object, "toString");
            return s instanceof StringReference str ? quote(str.value()) : null;
        }
        if (implementsType(object, "java.util.Map")) {
            Value set = invoke(object, "entrySet");
            Value entries = set instanceof ObjectReference o ? invoke(o, "toArray") : null;
            if (!(entries instanceof ArrayReference array)) {
                return null;
            }
            List<String> items = new ArrayList<>();
            for (Value entry : array.getValues(0, Math.min(array.length(), MAX_ITEMS))) {
                ObjectReference e = (ObjectReference) entry;
                items.add("[" + show(invoke(e, "getKey"), depth + 1) + "] = " + show(invoke(e, "getValue"), depth + 1));
            }
            return braces(items, array.length());
        }
        if (implementsType(object, "java.util.Collection")) {
            Value all = invoke(object, "toArray");
            if (!(all instanceof ArrayReference array)) {
                return null;
            }
            List<String> items = new ArrayList<>();
            for (Value v : array.getValues(0, Math.min(array.length(), MAX_ITEMS))) {
                items.add(show(v, depth + 1));
            }
            return braces(items, array.length());
        }
        return null;
    }

    private static boolean implementsType(ObjectReference object, String name) {
        if (!(object.referenceType() instanceof ClassType type)) {
            return false;
        }
        for (com.sun.jdi.InterfaceType i : type.allInterfaces()) {
            if (i.name().equals(name)) {
                return true;
            }
        }
        return false;
    }

    /** Call a method without arguments of an object on the paused thread. */
    private Value invoke(ObjectReference object, String name) throws Exception {
        return invoke(object, name, Collections.emptyList());
    }

    private Value invoke(ObjectReference object, String name, List<Value> arguments) throws Exception {
        Method method = null;
        for (Method m : object.referenceType().methodsByName(name)) {
            if (!m.isStatic() && !m.isAbstract() && m.argumentTypeNames().size() == arguments.size()) {
                method = m;
                break;
            }
        }
        if (method == null) {
            throw new IllegalArgumentException("No method " + name + " with " + arguments.size() + " arguments.");
        }
        return object.invokeMethod(thread, method, arguments, ObjectReference.INVOKE_SINGLE_THREADED);
    }

    // ------------------------------------------------------------------ expressions of conditions and watches

    /**
     * A small Java expression evaluated in a frame: literals, variables, this, fields, array elements, length, calls
     * of methods, + - * / %, comparisons, && || !. Numbers are computed as long or double, text as String.
     */
    private final class Expression {
        private final String text;
        private final ThreadReference on;
        private final int level;
        private int at;

        Expression(String text, ThreadReference on, int level) {
            this.text = text;
            this.on = on;
            this.level = level;
        }

        Object evaluate() throws Exception {
            if (on == null) {
                throw new IllegalStateException("The program is not paused.");
            }
            Object value = or();
            space();
            if (at < text.length()) {
                throw new IllegalArgumentException("Unexpected " + text.substring(at));
            }
            return value;
        }

        private void space() {
            while (at < text.length() && Character.isWhitespace(text.charAt(at))) {
                at++;
            }
        }

        private boolean eat(String s) {
            space();
            if (text.startsWith(s, at)) {
                // Not the first character of a longer operator (< of <=, & of &&).
                if ((s.equals("<") || s.equals(">") || s.equals("!") || s.equals("=")) && text.startsWith("=", at + 1)) {
                    return false;
                }
                at += s.length();
                return true;
            }
            return false;
        }

        private Object or() throws Exception {
            Object left = and();
            while (eat("||")) {
                Object right = and();
                left = truth(left) || truth(right);
            }
            return left;
        }

        private Object and() throws Exception {
            Object left = compare();
            while (eat("&&")) {
                Object right = compare();
                left = truth(left) && truth(right);
            }
            return left;
        }

        private Object compare() throws Exception {
            Object left = sum();
            for (String op : new String[] {"==", "!=", "<=", ">=", "<", ">"}) {
                if (eat(op)) {
                    Object right = sum();
                    return compare(op, left, right);
                }
            }
            return left;
        }

        private Object compare(String op, Object a, Object b) {
            Object x = plain(a);
            Object y = plain(b);
            if (x instanceof Number || y instanceof Number) {
                double p = number(x);
                double q = number(y);
                return switch (op) {
                    case "==" -> p == q;
                    case "!=" -> p != q;
                    case "<" -> p < q;
                    case "<=" -> p <= q;
                    case ">" -> p > q;
                    default -> p >= q;
                };
            }
            boolean same = x == null ? y == null : x.equals(y);
            if (op.equals("==")) {
                return same;
            }
            if (op.equals("!=")) {
                return !same;
            }
            throw new IllegalArgumentException("Cannot compare these values.");
        }

        private Object sum() throws Exception {
            Object left = product();
            while (true) {
                if (eat("+")) {
                    Object right = product();
                    Object x = plain(left);
                    Object y = plain(right);
                    left = x instanceof String || y instanceof String ? str(x) + str(y) : arithmetic('+', x, y);
                } else if (eat("-")) {
                    left = arithmetic('-', plain(left), plain(product()));
                } else {
                    return left;
                }
            }
        }

        private Object product() throws Exception {
            Object left = unary();
            while (true) {
                char op;
                if (eat("*")) {
                    op = '*';
                } else if (eat("/")) {
                    op = '/';
                } else if (eat("%")) {
                    op = '%';
                } else {
                    return left;
                }
                left = arithmetic(op, plain(left), plain(unary()));
            }
        }

        private Object unary() throws Exception {
            if (eat("!")) {
                return !truth(unary());
            }
            if (eat("-")) {
                return arithmetic('-', 0L, plain(unary()));
            }
            return postfix(primary());
        }

        private Object primary() throws Exception {
            space();
            if (eat("(")) {
                Object value = or();
                if (!eat(")")) {
                    throw new IllegalArgumentException("Missing )");
                }
                return value;
            }
            char c = at < text.length() ? text.charAt(at) : '\0';
            if (c == '"') {
                StringBuilder s = new StringBuilder();
                at++;
                while (at < text.length() && text.charAt(at) != '"') {
                    if (text.charAt(at) == '\\' && at + 1 < text.length()) {
                        at++;
                    }
                    s.append(text.charAt(at++));
                }
                at++;
                return s.toString();
            }
            if (c == '\'') {
                char ch = text.charAt(at + 1);
                at += 3;
                return ch;
            }
            if (Character.isDigit(c)) {
                int start = at;
                while (at < text.length() && (Character.isDigit(text.charAt(at)) || text.charAt(at) == '.')) {
                    at++;
                }
                String n = text.substring(start, at);
                if (at < text.length() && "LlDdFf".indexOf(text.charAt(at)) >= 0) {
                    at++;
                }
                return n.contains(".") ? (Object) Double.parseDouble(n) : (Object) Long.parseLong(n);
            }
            if (Character.isJavaIdentifierStart(c)) {
                String name = identifier();
                switch (name) {
                    case "true":
                        return true;
                    case "false":
                        return false;
                    case "null":
                        return null;
                    case "this":
                        return frame().thisObject();
                    default:
                        return variable(name);
                }
            }
            throw new IllegalArgumentException("Unexpected " + text.substring(at));
        }

        private String identifier() {
            int start = at;
            while (at < text.length() && Character.isJavaIdentifierPart(text.charAt(at))) {
                at++;
            }
            return text.substring(start, at);
        }

        private StackFrame frame() throws IncompatibleThreadStateException {
            return on.frame(level);
        }

        private Object variable(String name) throws Exception {
            StackFrame frame = frame();
            try {
                LocalVariable local = frame.visibleVariableByName(name);
                if (local != null) {
                    return frame.getValue(local);
                }
            } catch (AbsentInformationException e) {
                // No local variables.
            }
            ObjectReference self = frame.thisObject();
            if (self != null) {
                Field f = self.referenceType().fieldByName(name);
                if (f != null) {
                    return self.getValue(f);
                }
            }
            ReferenceType type = frame.location().declaringType();
            Field f = type.fieldByName(name);
            if (f != null && f.isStatic()) {
                return type.getValue(f);
            }
            throw new IllegalArgumentException("No variable " + name);
        }

        private Object postfix(Object value) throws Exception {
            while (true) {
                if (eat(".")) {
                    space();
                    String name = identifier();
                    space();
                    if (at < text.length() && text.charAt(at) == '(') {
                        at++;
                        List<Value> arguments = new ArrayList<>();
                        while (!eat(")")) {
                            arguments.add(mirror(or()));
                            eat(",");
                        }
                        if (!(value instanceof ObjectReference o)) {
                            throw new IllegalArgumentException("No object for " + name + "()");
                        }
                        value = invokeOn(o, name, arguments);
                    } else {
                        value = field(value, name);
                    }
                } else if (eat("[")) {
                    Object index = plain(or());
                    if (!eat("]")) {
                        throw new IllegalArgumentException("Missing ]");
                    }
                    if (!(value instanceof ArrayReference array)) {
                        throw new IllegalArgumentException("Not an array");
                    }
                    value = array.getValue((int) number(index));
                } else {
                    return value;
                }
            }
        }

        private Value invokeOn(ObjectReference object, String name, List<Value> arguments) throws Exception {
            Method method = null;
            for (Method m : object.referenceType().methodsByName(name)) {
                if (!m.isStatic() && !m.isAbstract() && m.argumentTypeNames().size() == arguments.size()) {
                    method = m;
                    break;
                }
            }
            if (method == null) {
                throw new IllegalArgumentException("No method " + name);
            }
            Value result = object.invokeMethod(on, method, arguments, ObjectReference.INVOKE_SINGLE_THREADED);
            return result;
        }

        private Object field(Object value, String name) {
            if (value instanceof ArrayReference array && name.equals("length")) {
                return (long) array.length();
            }
            if (value instanceof ObjectReference object) {
                Field f = object.referenceType().fieldByName(name);
                if (f != null) {
                    return object.getValue(f);
                }
            }
            throw new IllegalArgumentException("No field " + name);
        }

        /** A computed value as a value of the program (arguments of a call). */
        private Value mirror(Object value) {
            Object x = plain(value);
            if (value instanceof Value v) {
                return v;
            }
            if (x instanceof Long l) {
                return l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE ? vm.mirrorOf(l.intValue()) : vm.mirrorOf(l);
            }
            if (x instanceof Double d) {
                return vm.mirrorOf(d);
            }
            if (x instanceof Boolean b) {
                return vm.mirrorOf(b);
            }
            if (x instanceof Character c) {
                return vm.mirrorOf(c);
            }
            if (x instanceof String s) {
                return vm.mirrorOf(s);
            }
            return null;
        }

        /** A value of the program as a plain Java value where it has one (numbers, text, truth). */
        private Object plain(Object value) {
            if (value instanceof ObjectReference o && !(value instanceof StringReference) && !(value instanceof ArrayReference)) {
                Value boxed = boxedValue(o);
                if (boxed != null) {
                    value = boxed;
                }
            }
            if (value instanceof BooleanValue b) {
                return b.value();
            }
            if (value instanceof CharValue c) {
                return c.value();
            }
            if (value instanceof com.sun.jdi.DoubleValue || value instanceof com.sun.jdi.FloatValue) {
                return ((PrimitiveValue) value).doubleValue();
            }
            if (value instanceof PrimitiveValue p) {
                return p.longValue();
            }
            if (value instanceof StringReference s) {
                return s.value();
            }
            if (value instanceof Integer i) {
                return (long) i;
            }
            return value;
        }

        private boolean truth(Object value) {
            Object x = plain(value);
            if (x instanceof Boolean b) {
                return b;
            }
            throw new IllegalArgumentException("Not true or false");
        }

        private double number(Object value) {
            Object x = plain(value);
            if (x instanceof Character c) {
                return c;
            }
            if (x instanceof Number n) {
                return n.doubleValue();
            }
            throw new IllegalArgumentException("Not a number");
        }

        private String str(Object value) {
            return value instanceof String s ? s : text(value);
        }

        private Object arithmetic(char op, Object x, Object y) {
            if (x instanceof Character c) {
                x = (long) c;
            }
            if (y instanceof Character c) {
                y = (long) c;
            }
            if (x instanceof Long a && y instanceof Long b) {
                return switch (op) {
                    case '+' -> a + b;
                    case '-' -> a - b;
                    case '*' -> a * b;
                    case '/' -> a / b;
                    default -> a % b;
                };
            }
            double a = number(x);
            double b = number(y);
            return switch (op) {
                case '+' -> a + b;
                case '-' -> a - b;
                case '*' -> a * b;
                case '/' -> a / b;
                default -> a % b;
            };
        }
    }

    // ------------------------------------------------------------------ MI text

    /** Words of a command: quoted ones with \" and \\ inside. */
    private static List<String> split(String line) {
        List<String> words = new ArrayList<>();
        int i = 0;
        while (i < line.length()) {
            char c = line.charAt(i);
            if (Character.isWhitespace(c)) {
                i++;
            } else if (c == '"') {
                StringBuilder w = new StringBuilder();
                i++;
                while (i < line.length() && line.charAt(i) != '"') {
                    if (line.charAt(i) == '\\' && i + 1 < line.length()) {
                        i++;
                    }
                    w.append(line.charAt(i++));
                }
                i++;
                words.add(w.toString());
            } else {
                int start = i;
                while (i < line.length() && !Character.isWhitespace(line.charAt(i))) {
                    i++;
                }
                words.add(line.substring(start, i));
            }
        }
        return words;
    }

    private static String escape(String s) {
        StringBuilder out = new StringBuilder();
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\t' -> out.append("\\t");
                case '\r' -> out.append("\\r");
                default -> out.append(c);
            }
        }
        return out.toString();
    }
}
