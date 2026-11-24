// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/*
 * Java language service of the runner (lib/analysis.js): the compiler of the JDK used as a library (javax.tools and
 * com.sun.source), with the release of the JDK that runs and grades the programs. Reads one JSON request per line on
 * stdin and writes one JSON answer per line on stdout: completions, their descriptions, the signatures of a call,
 * tooltips (declaration and Javadoc from the JDK's src.zip) and the errors of the compiler. Programs are only analyzed,
 * never run. Built by the runner with javac at its start; needs only the JDK (and openjdk-21-source for the Javadoc).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

import com.sun.source.doctree.DocCommentTree;
import com.sun.source.doctree.DocTree;
import com.sun.source.doctree.EntityTree;
import com.sun.source.doctree.LinkTree;
import com.sun.source.doctree.LiteralTree;
import com.sun.source.doctree.ParamTree;
import com.sun.source.doctree.StartElementTree;
import com.sun.source.doctree.TextTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ErroneousTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.Scope;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.DocTrees;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.ModuleElement;
import javax.lang.model.element.PackageElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.ArrayType;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.type.TypeKind;
import javax.lang.model.type.TypeMirror;
import javax.lang.model.util.ElementFilter;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

public final class JavaAnalyzer {
    /** The name put where the reader types, so that the compiler tells what may stand there. */
    private static final String HOLE = "__codelab__";
    private static final JavaCompiler COMPILER = ToolProvider.getSystemJavaCompiler();
    private static final StandardJavaFileManager FILES =
        COMPILER.getStandardFileManager(null, Locale.ROOT, StandardCharsets.UTF_8);
    private static final String RELEASE = String.valueOf(Runtime.version().feature());
    private static final List<String> OPTIONS = List.of("-proc:none", "--release", RELEASE, "-Xlint:none");
    private static final Pattern PUBLIC_TYPE = Pattern.compile(
        "\\bpublic\\s+(?:(?:final|abstract|sealed|non-sealed|static|strictfp)\\s+)*(?:class|interface|enum|record)\\s+([A-Za-z_$][\\w$]*)");
    private static final List<String> KEYWORDS = List.of("abstract", "boolean", "break", "byte", "case", "catch", "char",
        "class", "continue", "default", "do", "double", "else", "enum", "extends", "false", "final", "finally", "float",
        "for", "if", "implements", "import", "instanceof", "int", "interface", "long", "new", "null", "package",
        "private", "protected", "public", "record", "return", "short", "static", "super", "switch", "this", "throw",
        "throws", "true", "try", "var", "void", "while", "yield");

    private static final Object OUT_LOCK = new Object();
    private static OutputStream out;

    private JavaAnalyzer() {
    }

    public static void main(String[] args) throws IOException {
        out = new FileOutputStream(FileDescriptor.out);
        // One compiler at a time: the file manager of the platform classes is shared between the tasks.
        ExecutorService worker = Executors.newSingleThreadExecutor();
        worker.submit(JavaAnalyzer::warmUp);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            Map<String, Object> request;
            try {
                request = Json.object(line);
            } catch (RuntimeException e) {
                continue;
            }
            worker.submit(() -> {
                Object id = request.get("id");
                Map<String, Object> answer;
                try {
                    answer = handle(request);
                } catch (Throwable e) {
                    System.err.println(request.get("op") + ": " + e);
                    answer = new LinkedHashMap<>();
                    answer.put("error", "analyzer");
                }
                answer.put("id", id);
                write(answer);
            });
        }
        worker.shutdown();
    }

    private static void write(Map<String, Object> answer) {
        byte[] bytes = (Json.write(answer) + "\n").getBytes(StandardCharsets.UTF_8);
        synchronized (OUT_LOCK) {
            try {
                out.write(bytes);
                out.flush();
            } catch (IOException e) {
                System.exit(1);
            }
        }
    }

    private static void warmUp() {
        String code = "import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n"
            + "        List<Integer> list = new ArrayList<>();\n        list.add(5);\n"
            + "        System.out.println(list.size());\n    }\n}\n";
        try {
            handle(Map.of("op", "complete", "code", code, "line", 6L, "column", 14L));
            handle(Map.of("op", "hover", "code", code, "line", 6L, "column", 15L));
            handle(Map.of("op", "signatures", "code", code, "line", 7L, "column", 28L));
            handle(Map.of("op", "diagnostics", "code", code));
        } catch (Exception e) {
            System.err.println("warm up: " + e);
        }
    }

    static Map<String, Object> handle(Map<String, Object> request) throws IOException {
        return switch (String.valueOf(request.get("op"))) {
            case "complete" -> complete(request, false);
            case "describe" -> complete(request, true);
            case "signatures" -> signatures(request);
            case "hover" -> hover(request);
            case "diagnostics" -> diagnostics(request);
            default -> new LinkedHashMap<>(Map.of("error", "request"));
        };
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Sources and the compiler

    /** A program file in memory. */
    private static final class Source extends SimpleJavaFileObject {
        final String code;

        Source(String name, String code) {
            super(URI.create("string:///" + name), Kind.SOURCE);
            this.code = code;
        }

        @Override
        public CharSequence getCharContent(boolean ignoreEncodingErrors) {
            return code;
        }
    }

    /** The file name the program must have: its public class, else Main.java. */
    static String mainName(String code) {
        Matcher m = PUBLIC_TYPE.matcher(code);
        return m.find() ? m.group(1) + ".java" : "Main.java";
    }

    /** One analysis of the program with its other files. */
    private static final class Unit {
        JavacTask task;
        DocTrees trees;
        Elements elements;
        Types types;
        CompilationUnitTree main;
        String code;
        String name;
        DiagnosticCollector<JavaFileObject> diagnostics;
    }

    @SuppressWarnings("unchecked")
    private static Unit analyze(Map<String, Object> request, String code) throws IOException {
        Unit u = new Unit();
        u.code = code;
        u.name = mainName(String.valueOf(request.getOrDefault("code", "")));
        List<Source> sources = new ArrayList<>();
        sources.add(new Source(u.name, code));
        Object files = request.get("files");
        if (files instanceof List<?> list) {
            for (Object f : list) {
                if (f instanceof Map<?, ?> file && file.get("name") instanceof String name
                        && file.get("code") instanceof String text && name.endsWith(".java") && !name.equals(u.name)) {
                    sources.add(new Source(name, text));
                }
            }
        }
        u.diagnostics = new DiagnosticCollector<>();
        u.task = (JavacTask) COMPILER.getTask(null, FILES, u.diagnostics, OPTIONS, null, sources);
        // Before parsing: keeps the doc comments of the reader's own code.
        u.trees = DocTrees.instance(u.task);
        u.elements = u.task.getElements();
        u.types = u.task.getTypes();
        for (CompilationUnitTree cu : u.task.parse()) {
            if (cu.getSourceFile().getName().endsWith("/" + u.name) || cu.getSourceFile().toUri().getPath().endsWith("/" + u.name)) {
                u.main = cu;
            }
        }
        u.task.analyze();
        return u;
    }

    /** The offset of a 1-based line and column, kept inside the text. */
    static int offset(String code, long line, long column) {
        int pos = 0;
        for (long l = 1; l < line; l++) {
            int next = code.indexOf('\n', pos);
            if (next < 0) {
                return code.length();
            }
            pos = next + 1;
        }
        int end = code.indexOf('\n', pos);
        if (end < 0) {
            end = code.length();
        }
        return (int) Math.max(pos, Math.min(pos + Math.max(column - 1, 0), end));
    }

    /** The 1-based line and column of an offset. */
    static int[] position(String code, long offset) {
        int line = 1;
        int start = 0;
        int max = (int) Math.min(Math.max(offset, 0), code.length());
        for (int i = 0; i < max; i++) {
            if (code.charAt(i) == '\n') {
                line++;
                start = i + 1;
            }
        }
        return new int[] {line, max - start + 1};
    }

    private static long number(Map<String, Object> request, String key) {
        return request.get(key) instanceof Number n ? n.longValue() : 0;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Finding trees, also inside the trees the parser kept around an error

    /** Calls the visitor for every tree with its path, also inside erroneous trees. */
    private static void scan(CompilationUnitTree cu, java.util.function.Predicate<TreePath> visitor) {
        new TreePathScanner<Void, Void>() {
            @Override
            public Void scan(Tree tree, Void v) {
                if (tree == null) {
                    return null;
                }
                TreePath path = new TreePath(getCurrentPath(), tree);
                if (!visitor.test(path)) {
                    return null;
                }
                return super.scan(tree, v);
            }

            @Override
            public Void visitErroneous(ErroneousTree tree, Void v) {
                if (tree.getErrorTrees() != null) {
                    for (Tree t : tree.getErrorTrees()) {
                        scan(t, v);
                    }
                }
                return null;
            }
        }.scan(new TreePath(cu), null);
    }

    /** The identifier or member select named name (the hole). */
    private static TreePath findName(Unit u, String name) {
        TreePath[] found = new TreePath[1];
        scan(u.main, (path) -> {
            Tree leaf = path.getLeaf();
            if (found[0] == null && (leaf instanceof IdentifierTree id && id.getName().contentEquals(name)
                    || leaf instanceof MemberSelectTree ms && ms.getIdentifier().contentEquals(name))) {
                found[0] = path;
            }
            return true;
        });
        return found[0];
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Display of elements and types

    private static final Pattern QUALIFIED = Pattern.compile("\\b(?:[a-z_][\\w]*\\.)+([A-Z][\\w$]*)");

    /** A type as a reader writes it: java.util.List<java.lang.String> is List<String>. */
    static String shortType(String text) {
        return QUALIFIED.matcher(text).replaceAll("$1");
    }

    private static String typeOf(TypeMirror type) {
        return shortType(type.toString());
    }

    /** The parameter names of a method: from the source of the JDK when the class file has none. */
    private static List<String> parameterNames(Unit u, ExecutableElement method) {
        List<String> names = new ArrayList<>();
        for (VariableElement p : method.getParameters()) {
            names.add(p.getSimpleName().toString());
        }
        boolean synthetic = names.stream().allMatch(n -> n.matches("arg\\d+"));
        if (synthetic && !names.isEmpty()) {
            Docs.Info info = Docs.of(u, method);
            if (info != null && info.parameters.size() == names.size()) {
                return info.parameters;
            }
        }
        return names;
    }

    private static List<String> parameterLabels(Unit u, ExecutableElement method) {
        List<String> names = parameterNames(u, method);
        List<String> labels = new ArrayList<>();
        List<? extends VariableElement> params = method.getParameters();
        for (int i = 0; i < params.size(); i++) {
            String type = typeOf(params.get(i).asType());
            if (method.isVarArgs() && i == params.size() - 1 && type.endsWith("[]")) {
                type = type.substring(0, type.length() - 2) + "...";
            }
            labels.add(type + " " + names.get(i));
        }
        return labels;
    }

    /** The declaration of an element, as in a tooltip. */
    static String declaration(Unit u, Element e) {
        String owner = e.getEnclosingElement() instanceof TypeElement t ? t.getSimpleName() + "." : "";
        return switch (e.getKind()) {
            case METHOD -> {
                ExecutableElement m = (ExecutableElement) e;
                String typeParams = m.getTypeParameters().isEmpty() ? "" : "<" + String.join(", ",
                    m.getTypeParameters().stream().map(Object::toString).toList()) + "> ";
                yield (m.getModifiers().contains(Modifier.STATIC) ? "static " : "") + typeParams
                    + typeOf(m.getReturnType()) + " " + owner + m.getSimpleName()
                    + "(" + String.join(", ", parameterLabels(u, m)) + ")";
            }
            case CONSTRUCTOR -> {
                ExecutableElement m = (ExecutableElement) e;
                yield e.getEnclosingElement().getSimpleName() + "(" + String.join(", ", parameterLabels(u, m)) + ")";
            }
            case FIELD, ENUM_CONSTANT -> (e.getModifiers().contains(Modifier.STATIC) ? "static " : "")
                + typeOf(e.asType()) + " " + owner + e.getSimpleName();
            case LOCAL_VARIABLE, RESOURCE_VARIABLE, EXCEPTION_PARAMETER, BINDING_VARIABLE ->
                typeOf(e.asType()) + " " + e.getSimpleName() + " (local variable)";
            case PARAMETER -> typeOf(e.asType()) + " " + e.getSimpleName() + " (parameter)";
            case CLASS, INTERFACE, ENUM, RECORD, ANNOTATION_TYPE -> e.getKind().toString().toLowerCase(Locale.ROOT)
                .replace("annotation_type", "@interface") + " " + ((TypeElement) e).getQualifiedName()
                + (((TypeElement) e).getTypeParameters().isEmpty() ? "" : "<" + String.join(", ",
                ((TypeElement) e).getTypeParameters().stream().map(Object::toString).toList()) + ">");
            case PACKAGE -> "package " + ((PackageElement) e).getQualifiedName();
            default -> e.toString();
        };
    }

    private static String kindOf(Element e) {
        return switch (e.getKind()) {
            case METHOD -> "Method";
            case CONSTRUCTOR -> "Constructor";
            case FIELD -> e.getModifiers().contains(Modifier.FINAL) && e.getModifiers().contains(Modifier.STATIC)
                ? "Constant" : "Field";
            case ENUM_CONSTANT -> "EnumMember";
            case CLASS, RECORD -> "Class";
            case INTERFACE, ANNOTATION_TYPE -> "Interface";
            case ENUM -> "Enum";
            case PACKAGE -> "Module";
            case LOCAL_VARIABLE, PARAMETER, RESOURCE_VARIABLE, EXCEPTION_PARAMETER, BINDING_VARIABLE -> "Variable";
            case TYPE_PARAMETER -> "TypeParameter";
            default -> "Text";
        };
    }

    private static boolean fromObject(Element e) {
        return e.getEnclosingElement() instanceof TypeElement t && t.getQualifiedName().contentEquals("java.lang.Object");
    }

    /** Whether the reader's code may use a member: public, or of the reader's own classes and not private elsewhere. */
    private static boolean usable(Unit u, Scope scope, Element member, TypeMirror site) {
        if (scope != null && site instanceof DeclaredType declared) {
            try {
                return u.trees.isAccessible(scope, member, declared);
            } catch (RuntimeException e) {
                // fall through
            }
        }
        if (member.getModifiers().contains(Modifier.PUBLIC)) {
            return true;
        }
        return u.trees.getPath(member) != null && !member.getModifiers().contains(Modifier.PRIVATE);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Completion

    /** A completion: one name, with all elements of that name (overloads). */
    private static final class Candidate {
        final String label;
        final String kind;
        final List<Element> elements = new ArrayList<>();
        final boolean inherited;

        Candidate(String label, String kind, boolean inherited) {
            this.label = label;
            this.kind = kind;
            this.inherited = inherited;
        }
    }

    private static void add(Map<String, Candidate> found, Element e) {
        String name = e.getSimpleName().toString();
        if (name.isEmpty() || name.equals(HOLE) || name.startsWith("<") || name.contains("$") || name.equals("this")
                || name.equals("super")) {
            return;
        }
        Candidate c = found.computeIfAbsent(name, n -> new Candidate(n, kindOf(e), fromObject(e)));
        if (c.elements.size() < 40) {
            c.elements.add(e);
        }
    }

    private static Scope scopeAt(Unit u, TreePath path) {
        try {
            return u.trees.getScope(path);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static Map<String, Object> complete(Map<String, Object> request, boolean describe) throws IOException {
        String code = String.valueOf(request.getOrDefault("code", ""));
        int caret = offset(code, number(request, "line"), number(request, "column"));
        int start = caret;
        while (start > 0 && Character.isJavaIdentifierPart(code.charAt(start - 1))) {
            start--;
        }
        int end = caret;
        while (end < code.length() && Character.isJavaIdentifierPart(code.charAt(end))) {
            end++;
        }
        int dot = start;
        while (dot > 0 && (code.charAt(dot - 1) == ' ' || code.charAt(dot - 1) == '\t')) {
            dot--;
        }
        boolean member = dot > 0 && code.charAt(dot - 1) == '.';
        Unit u = analyze(request, code.substring(0, start) + HOLE + code.substring(end));
        Map<String, Candidate> found = new LinkedHashMap<>();
        TreePath hole = findName(u, HOLE);
        boolean keywords = false;
        if (hole != null && member && hole.getLeaf() instanceof MemberSelectTree select) {
            members(u, hole, new TreePath(hole, select.getExpression()), found);
        } else if (hole != null && !member) {
            names(u, hole, found);
            keywords = true;
        }
        if (describe) {
            String item = String.valueOf(request.getOrDefault("item", ""));
            Candidate c = found.get(item);
            Map<String, Object> answer = new LinkedHashMap<>();
            if (c == null || c.elements.isEmpty()) {
                answer.put("text", "");
                answer.put("doc", "");
                return answer;
            }
            Element first = c.elements.get(0);
            answer.put("text", declaration(u, first) + (c.elements.size() > 1
                ? "  (+" + (c.elements.size() - 1) + " overload" + (c.elements.size() > 2 ? "s" : "") + ")" : ""));
            Docs.Info info = Docs.of(u, first);
            answer.put("doc", info == null ? "" : info.summary);
            return answer;
        }
        List<Object> items = new ArrayList<>();
        for (Candidate c : found.values()) {
            Element first = c.elements.get(0);
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("label", c.label);
            item.put("insert", c.label);
            item.put("kind", c.kind);
            item.put("filter", c.label);
            item.put("sort", (c.inherited ? "8" : first.getKind() == ElementKind.PACKAGE ? "5" : "1") + c.label);
            item.put("detail", first.getKind() == ElementKind.METHOD ? typeOf(((ExecutableElement) first).getReturnType())
                : first.getKind().isField() || first.getKind() == ElementKind.LOCAL_VARIABLE
                || first.getKind() == ElementKind.PARAMETER ? typeOf(first.asType()) : "");
            items.add(item);
            if (items.size() >= 3000) {
                break;
            }
        }
        if (keywords) {
            for (String k : KEYWORDS) {
                items.add(new LinkedHashMap<>(Map.of("label", k, "insert", k, "kind", "Keyword", "filter", k,
                    "sort", "6" + k, "detail", "")));
            }
        }
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("items", items);
        return answer;
    }

    /** The members after a dot: of a package, of a type (static) or of a value (instance). */
    private static void members(Unit u, TreePath hole, TreePath receiver, Map<String, Candidate> found) {
        Element target = u.trees.getElement(receiver);
        TypeMirror type = u.trees.getTypeMirror(receiver);
        Scope scope = scopeAt(u, hole);
        if (target instanceof PackageElement pkg) {
            for (Element e : pkg.getEnclosedElements()) {
                if (e.getModifiers().contains(Modifier.PUBLIC)) {
                    add(found, e);
                }
            }
            return;
        }
        boolean isType = target instanceof TypeElement && receiver.getLeaf() instanceof ExpressionTree expr
            && (expr instanceof IdentifierTree || expr instanceof MemberSelectTree);
        if (isType) {
            TypeElement te = (TypeElement) target;
            for (Element e : u.elements.getAllMembers(te)) {
                boolean isStatic = e.getModifiers().contains(Modifier.STATIC) || e.getKind().isClass()
                    || e.getKind().isInterface();
                if (isStatic && e.getKind() != ElementKind.CONSTRUCTOR && e.getKind() != ElementKind.STATIC_INIT
                        && usable(u, scope, e, te.asType())) {
                    add(found, e);
                }
            }
            found.putIfAbsent("class", new Candidate("class", "Keyword", false));
            found.get("class").elements.add(te);
            return;
        }
        if (type == null) {
            return;
        }
        if (type.getKind() == TypeKind.ARRAY) {
            Candidate length = new Candidate("length", "Field", false);
            length.elements.add(u.elements.getTypeElement("java.lang.Object"));
            found.put("length", length);
            type = u.elements.getTypeElement("java.lang.Object").asType();
        }
        if (type.getKind() == TypeKind.TYPEVAR || type.getKind() == TypeKind.INTERSECTION) {
            type = u.types.erasure(type);
        }
        if (type.getKind() != TypeKind.DECLARED) {
            return;
        }
        TypeElement te = (TypeElement) u.types.asElement(type);
        for (Element e : u.elements.getAllMembers(te)) {
            ElementKind k = e.getKind();
            if ((k == ElementKind.METHOD || k.isField()) && !e.getModifiers().contains(Modifier.STATIC)
                    && usable(u, scope, e, type)) {
                add(found, e);
            }
        }
    }

    /** The names where the reader types: locals, parameters, members of the enclosing classes, and the types. */
    private static void names(Unit u, TreePath hole, Map<String, Candidate> found) {
        Scope scope = scopeAt(u, hole);
        for (Scope s = scope; s != null; s = s.getEnclosingScope()) {
            for (Element e : s.getLocalElements()) {
                add(found, e);
            }
            TypeElement cls = s.getEnclosingClass();
            if (cls != null && s.getEnclosingMethod() == null) {
                for (Element e : u.elements.getAllMembers(cls)) {
                    if (e.getKind() != ElementKind.CONSTRUCTOR && e.getKind() != ElementKind.STATIC_INIT
                            && e.getKind() != ElementKind.INSTANCE_INIT) {
                        add(found, e);
                    }
                }
            }
        }
        if (scope != null && scope.getEnclosingClass() != null) {
            for (Element e : u.elements.getAllMembers(scope.getEnclosingClass())) {
                if (e.getKind() == ElementKind.METHOD || e.getKind().isField()) {
                    add(found, e);
                }
            }
        }
        // Types of this program, of java.lang and of the imports.
        for (Tree t : u.main.getTypeDecls()) {
            Element e = u.trees.getElement(new TreePath(new TreePath(u.main), t));
            if (e != null) {
                add(found, e);
            }
        }
        List<PackageElement> packages = new ArrayList<>();
        packages.add(u.elements.getPackageElement("java.lang"));
        for (ImportTree imp : u.main.getImports()) {
            if (imp.isStatic()) {
                continue;
            }
            String name = imp.getQualifiedIdentifier().toString();
            if (name.endsWith(".*")) {
                PackageElement p = u.elements.getPackageElement(name.substring(0, name.length() - 2));
                if (p != null) {
                    packages.add(p);
                }
            } else {
                TypeElement t = u.elements.getTypeElement(name);
                if (t != null) {
                    add(found, t);
                }
            }
        }
        for (PackageElement p : packages) {
            if (p == null) {
                continue;
            }
            for (Element e : p.getEnclosedElements()) {
                if (e.getModifiers().contains(Modifier.PUBLIC)) {
                    add(found, e);
                }
            }
        }
        for (String root : List.of("java", "javax")) {
            PackageElement p = u.elements.getPackageElement(root);
            if (p != null) {
                Candidate c = new Candidate(root, "Module", false);
                c.elements.add(p);
                found.putIfAbsent(root, c);
            }
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Tooltips

    private static Map<String, Object> hover(Map<String, Object> request) throws IOException {
        String code = String.valueOf(request.getOrDefault("code", ""));
        int caret = offset(code, number(request, "line"), number(request, "column"));
        Unit u = analyze(request, code);
        SourcePositions sp = u.trees.getSourcePositions();
        TreePath[] best = new TreePath[1];
        long[] span = new long[] {-1, Long.MAX_VALUE};
        scan(u.main, (path) -> {
            Tree leaf = path.getLeaf();
            long s = sp.getStartPosition(u.main, leaf);
            long e = sp.getEndPosition(u.main, leaf);
            if (s < 0 || e < 0 || caret < s || caret > e) {
                return s < 0 || e < 0 || (caret >= s && caret <= e);
            }
            long nameStart = -1;
            if (leaf instanceof IdentifierTree) {
                nameStart = s;
            } else if (leaf instanceof MemberSelectTree ms) {
                nameStart = e - ms.getIdentifier().length();
            } else if (leaf instanceof VariableTree || leaf instanceof MethodTree || leaf instanceof ClassTree) {
                String name = leaf instanceof VariableTree v ? v.getName().toString()
                    : leaf instanceof MethodTree m ? m.getName().toString() : ((ClassTree) leaf).getSimpleName().toString();
                int at = name.isEmpty() || name.startsWith("<") ? -1 : findWord(code, name, (int) s, (int) e);
                if (at >= 0 && caret >= at && caret <= at + name.length() && name.length() < span[1]) {
                    best[0] = path;
                    span[0] = at;
                    span[1] = name.length();
                }
                return true;
            }
            if (nameStart >= 0 && caret >= nameStart && e - nameStart <= span[1]) {
                best[0] = path;
                span[0] = nameStart;
                span[1] = e - nameStart;
            }
            return true;
        });
        Map<String, Object> answer = new LinkedHashMap<>();
        List<Object> markdown = new ArrayList<>();
        answer.put("markdown", markdown);
        if (best[0] == null) {
            return answer;
        }
        Element e = u.trees.getElement(best[0]);
        if (e == null || e.asType().getKind() == TypeKind.ERROR && e.getKind() != ElementKind.PACKAGE) {
            return answer;
        }
        if (best[0].getParentPath() != null && best[0].getParentPath().getLeaf() instanceof NewClassTree nc
                && nc.getIdentifier() == best[0].getLeaf()) {
            Element constructor = u.trees.getElement(best[0].getParentPath());
            if (constructor != null) {
                e = constructor;
            }
        }
        markdown.add("```java\n" + declaration(u, e) + "\n```");
        Docs.Info info = Docs.of(u, e);
        if (info != null && !info.summary.isEmpty()) {
            markdown.add(escape(info.summary));
        }
        int[] from = position(code, span[0]);
        int[] to = position(code, span[0] + span[1]);
        answer.put("line", from[0]);
        answer.put("column", from[1]);
        answer.put("endLine", to[0]);
        answer.put("endColumn", to[1]);
        return answer;
    }

    private static int findWord(String code, String word, int from, int to) {
        Matcher m = Pattern.compile("\\b" + Pattern.quote(word) + "\\b").matcher(code);
        m.region(Math.max(0, from), Math.min(code.length(), Math.max(from, to)));
        return m.find() ? m.start() : -1;
    }

    static String escape(String text) {
        StringBuilder b = new StringBuilder(text.length());
        for (char c : text.toCharArray()) {
            if ("\\`*_{}[]<>#|".indexOf(c) >= 0) {
                b.append('\\');
            }
            b.append(c);
        }
        return b.toString();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Signatures of a call

    private static Map<String, Object> signatures(Map<String, Object> request) throws IOException {
        String code = String.valueOf(request.getOrDefault("code", ""));
        int caret = offset(code, number(request, "line"), number(request, "column"));
        Unit u = analyze(request, code);
        SourcePositions sp = u.trees.getSourcePositions();
        TreePath[] best = new TreePath[1];
        int[] open = new int[] {-1};
        scan(u.main, (path) -> {
            Tree leaf = path.getLeaf();
            Tree callee = leaf instanceof MethodInvocationTree mi ? mi.getMethodSelect()
                : leaf instanceof NewClassTree nc ? nc.getIdentifier() : null;
            if (callee != null) {
                long calleeEnd = sp.getEndPosition(u.main, callee);
                int paren = calleeEnd < 0 ? -1 : code.indexOf('(', (int) calleeEnd);
                long end = sp.getEndPosition(u.main, leaf);
                boolean closed = end > 0 && end <= code.length() && code.charAt((int) end - 1) == ')';
                if (paren >= 0 && caret > paren && (!closed || caret < end) && paren > open[0]) {
                    best[0] = path;
                    open[0] = paren;
                }
            }
            return true;
        });
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("signatures", List.of());
        answer.put("active", 0);
        answer.put("parameter", 0);
        if (best[0] == null) {
            return answer;
        }
        Tree call = best[0].getLeaf();
        List<ExecutableElement> methods = new ArrayList<>();
        Element chosen = u.trees.getElement(call instanceof MethodInvocationTree mi
            ? new TreePath(best[0], mi.getMethodSelect()) : best[0]);
        Scope scope = scopeAt(u, best[0]);
        if (call instanceof MethodInvocationTree mi) {
            String name;
            TypeMirror site;
            boolean statics = false;
            if (mi.getMethodSelect() instanceof MemberSelectTree ms) {
                name = ms.getIdentifier().toString();
                TreePath receiver = new TreePath(new TreePath(best[0], ms), ms.getExpression());
                Element target = u.trees.getElement(receiver);
                statics = target instanceof TypeElement;
                site = statics ? target.asType() : u.trees.getTypeMirror(receiver);
            } else {
                name = mi.getMethodSelect().toString();
                site = scope != null && scope.getEnclosingClass() != null ? scope.getEnclosingClass().asType() : null;
            }
            if (site != null && site.getKind() == TypeKind.DECLARED) {
                TypeElement te = (TypeElement) u.types.asElement(site);
                for (ExecutableElement m : ElementFilter.methodsIn(u.elements.getAllMembers(te))) {
                    if (m.getSimpleName().contentEquals(name) && (!statics || m.getModifiers().contains(Modifier.STATIC))
                            && usable(u, scope, m, site)) {
                        methods.add(m);
                    }
                }
            }
        } else if (call instanceof NewClassTree nc) {
            Element type = u.trees.getElement(new TreePath(best[0], nc.getIdentifier()));
            if (type instanceof TypeElement te) {
                for (ExecutableElement c : ElementFilter.constructorsIn(te.getEnclosedElements())) {
                    if (usable(u, scope, c, te.asType())) {
                        methods.add(c);
                    }
                }
            }
        }
        if (methods.isEmpty()) {
            return answer;
        }
        methods.sort((a, b) -> Integer.compare(a.getParameters().size(), b.getParameters().size()));
        if (methods.size() > 40) {
            methods = methods.subList(0, 40);
        }
        int parameter = commasBefore(code, open[0] + 1, caret);
        int active = -1;
        for (int i = 0; i < methods.size(); i++) {
            if (methods.get(i).equals(chosen)) {
                active = i;
            }
        }
        if (active < 0) {
            for (int i = 0; i < methods.size() && active < 0; i++) {
                ExecutableElement m = methods.get(i);
                if (m.getParameters().size() > parameter || m.isVarArgs()) {
                    active = i;
                }
            }
        }
        List<Object> list = new ArrayList<>();
        for (ExecutableElement m : methods) {
            Docs.Info info = Docs.of(u, m);
            List<String> labels = parameterLabels(u, m);
            List<String> names = parameterNames(u, m);
            List<Object> params = new ArrayList<>();
            for (int i = 0; i < labels.size(); i++) {
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("label", labels.get(i));
                p.put("doc", info == null ? "" : info.parameterDocs.getOrDefault(names.get(i), ""));
                params.add(p);
            }
            Map<String, Object> s = new LinkedHashMap<>();
            String returns = m.getKind() == ElementKind.CONSTRUCTOR ? "" : typeOf(m.getReturnType()) + " ";
            String name = m.getKind() == ElementKind.CONSTRUCTOR ? m.getEnclosingElement().getSimpleName().toString()
                : m.getSimpleName().toString();
            s.put("label", returns + name + "(" + String.join(", ", labels) + ")");
            s.put("doc", info == null ? "" : info.summary);
            s.put("parameters", params);
            list.add(s);
        }
        answer.put("signatures", list);
        answer.put("active", Math.max(active, 0));
        answer.put("parameter", parameter);
        return answer;
    }

    /** Commas at the top level of an argument list, from its start to the caret. */
    static int commasBefore(String code, int from, int to) {
        int depth = 0;
        int count = 0;
        for (int i = from; i < Math.min(to, code.length()); i++) {
            char c = code.charAt(i);
            if (c == '"' || c == '\'') {
                for (i++; i < to && code.charAt(i) != c; i++) {
                    if (code.charAt(i) == '\\') {
                        i++;
                    }
                }
            } else if (c == '(' || c == '[' || c == '{') {
                depth++;
            } else if (c == ')' || c == ']' || c == '}') {
                depth--;
            } else if (c == ',' && depth == 0) {
                count++;
            }
        }
        return count;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Errors

    private static Map<String, Object> diagnostics(Map<String, Object> request) throws IOException {
        String code = String.valueOf(request.getOrDefault("code", ""));
        Unit u = analyze(request, code);
        String culture = String.valueOf(request.getOrDefault("culture", ""));
        Locale locale = culture.isEmpty() ? Locale.ROOT : Locale.forLanguageTag(culture);
        Map<String, String> texts = new HashMap<>();
        texts.put(u.name, code);
        List<Object> items = new ArrayList<>();
        for (Diagnostic<? extends JavaFileObject> d : u.diagnostics.getDiagnostics()) {
            if (d.getSource() == null || d.getPosition() == Diagnostic.NOPOS
                    || d.getKind() != Diagnostic.Kind.ERROR && d.getKind() != Diagnostic.Kind.WARNING
                    && d.getKind() != Diagnostic.Kind.MANDATORY_WARNING) {
                continue;
            }
            String file = Path.of(d.getSource().toUri().getPath()).getFileName().toString();
            String text = file.equals(u.name) ? code : d.getSource().getCharContent(true).toString();
            long start = d.getStartPosition() >= 0 ? d.getStartPosition() : d.getPosition();
            long end = Math.max(d.getEndPosition(), start + 1);
            int[] from = position(text, start);
            int[] to = position(text, end);
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("file", file);
            item.put("severity", d.getKind() == Diagnostic.Kind.ERROR ? "error" : "warning");
            item.put("code", d.getCode());
            item.put("message", d.getMessage(locale));
            item.put("line", from[0]);
            item.put("column", from[1]);
            item.put("endLine", to[0]);
            item.put("endColumn", to[1]);
            items.add(item);
            if (items.size() >= 200) {
                break;
            }
        }
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("items", items);
        answer.put("main", u.name);
        return answer;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Javadoc: of the reader's code from its own comments, of the JDK from src.zip

    static final class Docs {
        /** Summary, the names and texts of the parameters. */
        static final class Info {
            String summary = "";
            List<String> parameters = new ArrayList<>();
            Map<String, String> parameterDocs = new HashMap<>();
        }

        private static final ZipFile SOURCES = openSources();
        private static final Map<String, Parsed> PARSED = Collections.synchronizedMap(new LinkedHashMap<>(64, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Parsed> eldest) {
                return size() > 48;
            }
        });

        private record Parsed(DocTrees trees, CompilationUnitTree unit) {
        }

        private static ZipFile openSources() {
            for (String path : List.of(System.getProperty("java.home") + "/lib/src.zip",
                    System.getProperty("java.home") + "/../lib/src.zip")) {
                try {
                    if (Files.isReadable(Path.of(path))) {
                        return new ZipFile(path);
                    }
                } catch (IOException e) {
                    // try the next
                }
            }
            return null;
        }

        private static Parsed parse(String entryName) {
            if (SOURCES == null) {
                return null;
            }
            return PARSED.computeIfAbsent(entryName, name -> {
                try {
                    ZipEntry entry = SOURCES.getEntry(name);
                    if (entry == null) {
                        return null;
                    }
                    String text = new String(SOURCES.getInputStream(entry).readAllBytes(), StandardCharsets.UTF_8);
                    String file = name.substring(name.lastIndexOf('/') + 1);
                    JavacTask task = (JavacTask) COMPILER.getTask(null, FILES, d -> { }, List.of("-proc:none"), null,
                        List.of(new Source(file, text)));
                    DocTrees trees = DocTrees.instance(task);
                    CompilationUnitTree unit = task.parse().iterator().next();
                    return new Parsed(trees, unit);
                } catch (IOException | RuntimeException e) {
                    return null;
                }
            });
        }

        static Info of(Unit u, Element e) {
            try {
                Info info = own(u, e);
                if (info == null) {
                    info = jdk(u, e);
                }
                if (info != null && info.summary.isEmpty() && e instanceof ExecutableElement m) {
                    Info inherited = overridden(u, m);
                    if (inherited != null) {
                        info.summary = inherited.summary;
                        if (info.parameterDocs.isEmpty()) {
                            info.parameterDocs = inherited.parameterDocs;
                        }
                    }
                }
                return info;
            } catch (RuntimeException ex) {
                return null;
            }
        }

        /** Docs of an element of the reader's program. */
        private static Info own(Unit u, Element e) {
            TreePath path = u.trees.getPath(e);
            if (path == null) {
                return null;
            }
            Info info = read(u.trees.getDocCommentTree(path));
            if (path.getLeaf() instanceof MethodTree m) {
                for (VariableTree p : m.getParameters()) {
                    info.parameters.add(p.getName().toString());
                }
            }
            return info;
        }

        private static Info overridden(Unit u, ExecutableElement m) {
            if (!(m.getEnclosingElement() instanceof TypeElement owner)) {
                return null;
            }
            List<TypeMirror> todo = new ArrayList<>(u.types.directSupertypes(owner.asType()));
            Set<String> seen = new HashSet<>();
            while (!todo.isEmpty()) {
                TypeMirror t = todo.remove(0);
                if (!(u.types.asElement(t) instanceof TypeElement te) || !seen.add(te.getQualifiedName().toString())) {
                    continue;
                }
                for (ExecutableElement other : ElementFilter.methodsIn(te.getEnclosedElements())) {
                    if (other.getSimpleName().equals(m.getSimpleName()) && u.elements.overrides(m, other, owner)) {
                        Info info = jdk(u, other);
                        if (info == null) {
                            info = own(u, other);
                        }
                        if (info != null && !info.summary.isEmpty()) {
                            return info;
                        }
                    }
                }
                todo.addAll(u.types.directSupertypes(t));
            }
            return null;
        }

        /** Docs of an element of the JDK, from its source in src.zip. */
        private static Info jdk(Unit u, Element e) {
            TypeElement top = null;
            for (Element x = e; x != null; x = x.getEnclosingElement()) {
                if (x instanceof TypeElement t && !(t.getEnclosingElement() instanceof TypeElement)) {
                    top = t;
                }
            }
            if (top == null) {
                return null;
            }
            ModuleElement module = u.elements.getModuleOf(top);
            if (module == null || module.isUnnamed()) {
                return null;
            }
            Parsed parsed = parse(module.getQualifiedName() + "/" + top.getQualifiedName().toString().replace('.', '/')
                + ".java");
            if (parsed == null) {
                return null;
            }
            // The chain of classes from the top-level one to the element.
            List<String> chain = new ArrayList<>();
            Element owner = e instanceof TypeElement ? e : e.getEnclosingElement();
            for (Element x = owner; x instanceof TypeElement; x = x.getEnclosingElement()) {
                chain.add(0, x.getSimpleName().toString());
            }
            ClassTree cls = null;
            List<? extends Tree> level = parsed.unit.getTypeDecls();
            for (String name : chain) {
                cls = null;
                for (Tree t : level) {
                    if (t instanceof ClassTree c && c.getSimpleName().contentEquals(name)) {
                        cls = c;
                        break;
                    }
                }
                if (cls == null) {
                    return null;
                }
                level = cls.getMembers();
            }
            Tree target = null;
            if (e instanceof TypeElement) {
                target = cls;
            } else if (e instanceof ExecutableElement m) {
                String name = m.getKind() == ElementKind.CONSTRUCTOR ? "<init>" : m.getSimpleName().toString();
                MethodTree byCount = null;
                for (Tree t : level) {
                    if (t instanceof MethodTree mt && mt.getName().contentEquals(name)
                            && mt.getParameters().size() == m.getParameters().size()) {
                        if (byCount == null) {
                            byCount = mt;
                        }
                        if (sameParameters(u, m, mt)) {
                            target = mt;
                            break;
                        }
                    }
                }
                if (target == null) {
                    target = byCount;
                }
            } else {
                for (Tree t : level) {
                    if (t instanceof VariableTree v && v.getName().contentEquals(e.getSimpleName())) {
                        target = t;
                        break;
                    }
                }
            }
            if (target == null) {
                return null;
            }
            Info info = read(parsed.trees.getDocCommentTree(TreePath.getPath(parsed.unit, target)));
            if (target instanceof MethodTree mt) {
                for (VariableTree p : mt.getParameters()) {
                    info.parameters.add(p.getName().toString());
                }
            }
            return info;
        }

        private static final Pattern GENERICS = Pattern.compile("<[^<>]*>");

        private static String simpleType(String text) {
            String t = text.replaceAll("@\\w+(\\([^)]*\\))?\\s*", "").replace("...", "[]").replaceAll("\\s+", "");
            String before;
            do {
                before = t;
                t = GENERICS.matcher(t).replaceAll("");
            } while (!t.equals(before));
            return t.substring(t.lastIndexOf('.') + 1);
        }

        private static boolean sameParameters(Unit u, ExecutableElement m, MethodTree tree) {
            List<? extends VariableElement> params = m.getParameters();
            for (int i = 0; i < params.size(); i++) {
                String compiled = simpleType(u.types.erasure(params.get(i).asType()).toString());
                String source = simpleType(tree.getParameters().get(i).getType().toString());
                // A type variable of the source (E, T, K) is Object or its bound after erasure.
                if (!compiled.equals(source) && !(source.matches("[A-Z][A-Z0-9]?(\\[\\])*") )) {
                    return false;
                }
            }
            return true;
        }

        private static Info read(DocCommentTree doc) {
            Info info = new Info();
            if (doc == null) {
                return info;
            }
            String body = text(doc.getFullBody());
            int paragraph = body.indexOf("\n\n");
            String first = (paragraph >= 0 ? body.substring(0, paragraph) : body).replaceAll("\\s+", " ").trim();
            info.summary = first.length() > 600 ? first.substring(0, 600) + " ..." : first;
            for (DocTree tag : doc.getBlockTags()) {
                if (tag instanceof ParamTree p && !p.isTypeParameter()) {
                    info.parameterDocs.put(p.getName().getName().toString(),
                        text(p.getDescription()).replaceAll("\\s+", " ").trim());
                }
            }
            return info;
        }

        private static final Map<String, String> ENTITIES = Map.of("lt", "<", "gt", ">", "amp", "&", "quot", "\"",
            "nbsp", " ", "apos", "'");

        private static String text(List<? extends DocTree> trees) {
            StringBuilder b = new StringBuilder();
            for (DocTree t : trees) {
                switch (t.getKind()) {
                    case TEXT -> b.append(((TextTree) t).getBody());
                    case CODE, LITERAL -> b.append(((LiteralTree) t).getBody().getBody());
                    case LINK, LINK_PLAIN -> {
                        LinkTree link = (LinkTree) t;
                        String label = text(link.getLabel()).trim();
                        if (label.isEmpty()) {
                            String sig = link.getReference().getSignature();
                            label = sig.startsWith("#") ? sig.substring(1) : sig.replace('#', '.');
                            label = shortType(label);
                        }
                        b.append(label);
                    }
                    case ENTITY -> b.append(ENTITIES.getOrDefault(((EntityTree) t).getName().toString(), ""));
                    case START_ELEMENT -> {
                        String name = ((StartElementTree) t).getName().toString().toLowerCase(Locale.ROOT);
                        if (name.equals("p") || name.equals("ul") || name.equals("ol") || name.equals("pre")
                                || name.equals("table")) {
                            b.append("\n\n");
                        }
                    }
                    case ERRONEOUS -> b.append(t.toString());
                    default -> {
                    }
                }
            }
            return b.toString();
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // A small JSON reader and writer (objects, arrays, strings, numbers, true, false, null)

    static final class Json {
        private final String s;
        private int i;

        private Json(String s) {
            this.s = s;
        }

        @SuppressWarnings("unchecked")
        static Map<String, Object> object(String text) {
            Object value = new Json(text).value();
            if (!(value instanceof Map)) {
                throw new IllegalArgumentException("not an object");
            }
            return (Map<String, Object>) value;
        }

        private void space() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
        }

        private Object value() {
            space();
            if (i >= s.length()) {
                throw new IllegalArgumentException("end");
            }
            char c = s.charAt(i);
            switch (c) {
                case '{' -> {
                    i++;
                    Map<String, Object> map = new LinkedHashMap<>();
                    space();
                    if (s.charAt(i) == '}') {
                        i++;
                        return map;
                    }
                    while (true) {
                        space();
                        String key = string();
                        space();
                        expect(':');
                        map.put(key, value());
                        space();
                        if (s.charAt(i) == ',') {
                            i++;
                        } else {
                            expect('}');
                            return map;
                        }
                    }
                }
                case '[' -> {
                    i++;
                    List<Object> list = new ArrayList<>();
                    space();
                    if (s.charAt(i) == ']') {
                        i++;
                        return list;
                    }
                    while (true) {
                        list.add(value());
                        space();
                        if (s.charAt(i) == ',') {
                            i++;
                        } else {
                            expect(']');
                            return list;
                        }
                    }
                }
                case '"' -> {
                    return string();
                }
                default -> {
                    if (s.startsWith("true", i)) {
                        i += 4;
                        return Boolean.TRUE;
                    }
                    if (s.startsWith("false", i)) {
                        i += 5;
                        return Boolean.FALSE;
                    }
                    if (s.startsWith("null", i)) {
                        i += 4;
                        return null;
                    }
                    int start = i;
                    while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) {
                        i++;
                    }
                    String num = s.substring(start, i);
                    if (num.isEmpty()) {
                        throw new IllegalArgumentException("value");
                    }
                    return num.matches("-?\\d+") ? (Object) Long.parseLong(num) : (Object) Double.parseDouble(num);
                }
            }
        }

        private void expect(char c) {
            if (i >= s.length() || s.charAt(i) != c) {
                throw new IllegalArgumentException("expected " + c);
            }
            i++;
        }

        private String string() {
            expect('"');
            StringBuilder b = new StringBuilder();
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') {
                    return b.toString();
                }
                if (c != '\\') {
                    b.append(c);
                    continue;
                }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n' -> b.append('\n');
                    case 't' -> b.append('\t');
                    case 'r' -> b.append('\r');
                    case 'b' -> b.append('\b');
                    case 'f' -> b.append('\f');
                    case 'u' -> {
                        b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                    }
                    default -> b.append(e);
                }
            }
        }

        static String write(Object value) {
            StringBuilder b = new StringBuilder();
            write(b, value);
            return b.toString();
        }

        private static void write(StringBuilder b, Object value) {
            if (value == null) {
                b.append("null");
            } else if (value instanceof String str) {
                b.append('"');
                for (char c : str.toCharArray()) {
                    switch (c) {
                        case '"' -> b.append("\\\"");
                        case '\\' -> b.append("\\\\");
                        case '\n' -> b.append("\\n");
                        case '\r' -> b.append("\\r");
                        case '\t' -> b.append("\\t");
                        default -> {
                            if (c < 0x20) {
                                b.append(String.format("\\u%04x", (int) c));
                            } else {
                                b.append(c);
                            }
                        }
                    }
                }
                b.append('"');
            } else if (value instanceof Number || value instanceof Boolean) {
                b.append(value);
            } else if (value instanceof Map<?, ?> map) {
                b.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!first) {
                        b.append(',');
                    }
                    first = false;
                    write(b, String.valueOf(entry.getKey()));
                    b.append(':');
                    write(b, entry.getValue());
                }
                b.append('}');
            } else if (value instanceof List<?> list) {
                b.append('[');
                for (int k = 0; k < list.size(); k++) {
                    if (k > 0) {
                        b.append(',');
                    }
                    write(b, list.get(k));
                }
                b.append(']');
            } else {
                write(b, value.toString());
            }
        }
    }
}
