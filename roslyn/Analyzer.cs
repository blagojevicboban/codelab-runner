// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

// The analysis: completions, their descriptions, the signatures of a call, tooltips and the errors of the compiler, for
// a program checked as C# 7.3 against the reference assemblies of .NET Framework 4.7.2 (what Mono's mcs compiles).
//
// @copyright  2026 Boban Blagojević
// @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later

using System.Collections.Immutable;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Host.Mef;
using Microsoft.CodeAnalysis.QuickInfo;
using Microsoft.CodeAnalysis.Text;

namespace CodeLab.Roslyn;

/// <summary>A request of the runner (lib/analysis.js cleanRequest()).</summary>
public sealed class Request
{
    public int Id { get; set; }
    public string Op { get; set; } = "";
    public string Code { get; set; } = "";
    public List<SourceFile>? Files { get; set; }
    /// <summary>1-based line of the position.</summary>
    public int Line { get; set; }
    /// <summary>1-based column of the position (as in Monaco).</summary>
    public int Column { get; set; }
    /// <summary>The completion to describe (its label).</summary>
    public string Item { get; set; } = "";
    /// <summary>Culture of the compiler's messages, e.g. de-DE ('' for English).</summary>
    public string Culture { get; set; } = "";
}

/// <summary>Another file of the program.</summary>
public sealed class SourceFile
{
    public string Name { get; set; } = "";
    public string Code { get; set; } = "";
}

public sealed class CSharpAnalyzer
{
    private const string MainFile = "Program.cs";

    /// <summary>The project every request starts from: references, C# 7.3, no documents.</summary>
    private readonly Solution baseSolution;
    private readonly ProjectId projectId;

    public CSharpAnalyzer()
    {
        var refs = Path.Combine(AppContext.BaseDirectory, "refs");
        var references = Directory.GetFiles(refs, "*.dll").OrderBy(f => f).Select(dll => {
            var xml = Path.ChangeExtension(dll, ".xml");
            var docs = File.Exists(xml) ? XmlDocumentationProvider.CreateFromFile(xml) : null;
            return (MetadataReference)MetadataReference.CreateFromFile(dll, documentation: docs);
        }).ToList();
        var workspace = new AdhocWorkspace(MefHostServices.DefaultHost);
        projectId = ProjectId.CreateNewId();
        var info = ProjectInfo.Create(projectId, VersionStamp.Create(), "Program", "Program", LanguageNames.CSharp,
            compilationOptions: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                allowUnsafe: true, nullableContextOptions: NullableContextOptions.Disable),
            parseOptions: new CSharpParseOptions(LanguageVersion.CSharp7_3),
            metadataReferences: references);
        baseSolution = workspace.CurrentSolution.AddProject(info);
    }

    /// <summary>The program of a request as a document of its own solution.</summary>
    private Document DocumentOf(Request request)
    {
        var solution = baseSolution;
        var main = DocumentId.CreateNewId(projectId);
        solution = solution.AddDocument(main, MainFile, SourceText.From(request.Code), filePath: MainFile);
        foreach (var file in request.Files ?? new List<SourceFile>()) {
            solution = solution.AddDocument(DocumentId.CreateNewId(projectId), file.Name, SourceText.From(file.Code),
                filePath: file.Name);
        }
        return solution.GetDocument(main)!;
    }

    /// <summary>The offset of a 1-based line and column, kept inside the text.</summary>
    private static int OffsetOf(SourceText text, int line, int column)
    {
        if (text.Lines.Count == 0) {
            return 0;
        }
        var l = text.Lines[Math.Clamp(line - 1, 0, text.Lines.Count - 1)];
        return Math.Clamp(l.Start + Math.Max(column - 1, 0), l.Start, l.End);
    }

    public async Task WarmUpAsync()
    {
        var code = "using System;\nusing System.Collections.Generic;\nclass P {\n    static void Main() {\n" +
            "        var a = new List<int>();\n        Console.WriteLine(a.Count);\n    }\n}\n";
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        try {
            await HandleAsync(new Request {Op = "complete", Code = code, Line = 6, Column = 30}, cancel.Token);
            await HandleAsync(new Request {Op = "hover", Code = code, Line = 6, Column = 18}, cancel.Token);
            await HandleAsync(new Request {Op = "signatures", Code = code, Line = 6, Column = 27}, cancel.Token);
            await HandleAsync(new Request {Op = "diagnostics", Code = code}, cancel.Token);
        } catch (Exception e) {
            Console.Error.WriteLine($"warm up: {e.Message}");
        }
    }

    public Task<object> HandleAsync(Request request, CancellationToken cancel) => request.Op switch {
        "complete" => CompleteAsync(request, cancel),
        "describe" => DescribeAsync(request, cancel),
        "signatures" => SignaturesAsync(request, cancel),
        "hover" => HoverAsync(request, cancel),
        "diagnostics" => DiagnosticsAsync(request, cancel),
        _ => Task.FromResult<object>(new {id = request.Id, error = "request"}),
    };

    /// <summary>The kind of a completion for Monaco (CompletionItemKind names).</summary>
    private static string KindOf(ImmutableArray<string> tags)
    {
        foreach (var tag in tags) {
            switch (tag) {
                case "Method": case "ExtensionMethod": return "Method";
                case "Property": return "Property";
                case "Field": return "Field";
                case "Event": return "Event";
                case "Class": return "Class";
                case "Structure": return "Struct";
                case "Interface": return "Interface";
                case "Enum": return "Enum";
                case "EnumMember": return "EnumMember";
                case "Delegate": return "Function";
                case "Namespace": return "Module";
                case "Keyword": return "Keyword";
                case "Constant": return "Constant";
                case "Local": case "Parameter": case "RangeVariable": return "Variable";
                case "TypeParameter": return "TypeParameter";
                case "Snippet": return "Snippet";
            }
        }
        return "Text";
    }

    private async Task<object> CompleteAsync(Request request, CancellationToken cancel)
    {
        var document = DocumentOf(request);
        var text = await document.GetTextAsync(cancel);
        var service = CompletionService.GetService(document);
        if (service == null) {
            return new {id = request.Id, items = Array.Empty<object>()};
        }
        var list = await service.GetCompletionsAsync(document, OffsetOf(text, request.Line, request.Column),
            cancellationToken: cancel);
        var items = list.ItemsList.Take(3000).Select(item => new {
            label = item.DisplayTextPrefix + item.DisplayText + item.DisplayTextSuffix,
            insert = item.DisplayText,
            kind = KindOf(item.Tags),
            filter = item.FilterText,
            sort = item.SortText,
            detail = item.InlineDescription,
        }).ToList();
        return new {id = request.Id, items};
    }

    private async Task<object> DescribeAsync(Request request, CancellationToken cancel)
    {
        var document = DocumentOf(request);
        var text = await document.GetTextAsync(cancel);
        var service = CompletionService.GetService(document);
        if (service == null) {
            return new {id = request.Id, text = ""};
        }
        var list = await service.GetCompletionsAsync(document, OffsetOf(text, request.Line, request.Column),
            cancellationToken: cancel);
        var item = list.ItemsList.FirstOrDefault(i =>
            i.DisplayTextPrefix + i.DisplayText + i.DisplayTextSuffix == request.Item);
        if (item == null) {
            return new {id = request.Id, text = ""};
        }
        var description = (await service.GetDescriptionAsync(document, item, cancel))?.Text ?? "";
        // The first line is the declaration, the rest its documentation.
        var lines = description.Replace("\r\n", "\n").Split('\n', 2);
        return new {id = request.Id, text = lines[0].Trim(), doc = lines.Length > 1 ? CleanText(lines[1]) : ""};
    }

    /// <summary>Markdown of a tooltip: the declaration as code, then the documentation.</summary>
    private static List<string> Markdown(QuickInfoItem info)
    {
        var parts = new List<string>();
        foreach (var section in info.Sections) {
            var value = section.Text.Trim();
            if (value == "") {
                continue;
            }
            if (section.Kind == QuickInfoSectionKinds.Description) {
                parts.Add("```csharp\n" + value + "\n```");
            } else {
                value = CleanText(value);
                if (value != "") {
                    parts.Add(EscapeMarkdown(value));
                }
            }
        }
        return parts;
    }

    private static string EscapeMarkdown(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var c in value) {
            if ("\\`*_{}[]<>#|".IndexOf(c) >= 0) {
                builder.Append('\\');
            }
            builder.Append(c);
        }
        return builder.ToString();
    }

    private async Task<object> HoverAsync(Request request, CancellationToken cancel)
    {
        var document = DocumentOf(request);
        var text = await document.GetTextAsync(cancel);
        var service = QuickInfoService.GetService(document);
        var info = service == null ? null
            : await service.GetQuickInfoAsync(document, OffsetOf(text, request.Line, request.Column), cancel);
        if (info == null) {
            return new {id = request.Id, markdown = Array.Empty<string>()};
        }
        var start = text.Lines.GetLinePosition(info.Span.Start);
        var end = text.Lines.GetLinePosition(info.Span.End);
        return new {
            id = request.Id,
            markdown = Markdown(info),
            line = start.Line + 1, column = start.Character + 1,
            endLine = end.Line + 1, endColumn = end.Character + 1,
        };
    }

    /// <summary>A cref as a reader writes it: T:System.Collections.Generic.List`1 is List&lt;T&gt;.</summary>
    private static string ShortName(string cref)
    {
        var name = cref.Contains(':') ? cref[(cref.IndexOf(':') + 1)..] : cref;
        var paren = name.IndexOf('(');
        if (paren >= 0) {
            name = name[..paren];
        }
        name = name.Split('.').Last();
        return Regex.Replace(name, @"`+(\d+)", m => m.Groups[1].Value == "1" ? "<T>" : "<...>");
    }

    /// <summary>The text of the .NET documentation without its line breaks and the note about the Reference Source.</summary>
    private static string CleanText(string text)
    {
        text = Regex.Replace(text, @"\s+", " ");
        text = Regex.Replace(text, @"(?<=[a-z\)])\.(?=[A-Z])", ". ");
        text = Regex.Replace(text, @"\s*To browse the \.NET Framework source code for this type, see the Reference Source\.?", "");
        return text.Trim();
    }

    /// <summary>The summary and the parameter texts of a documentation comment.</summary>
    private static (string Summary, Dictionary<string, string> Parameters) DocsOf(ISymbol symbol)
    {
        var xml = symbol.GetDocumentationCommentXml(expandIncludes: false) ?? "";
        var parameters = new Dictionary<string, string>();
        if (xml.Trim() == "") {
            return ("", parameters);
        }
        try {
            var root = XElement.Parse(xml.StartsWith("<member") ? xml : "<member>" + xml + "</member>");
            string Flat(XElement? e) => e == null ? "" : CleanText(string.Concat(e.DescendantNodes().Select(n => n switch {
                XText t => t.Value,
                XElement x when x.Name == "see" || x.Name == "seealso" =>
                    (string?)x.Attribute("langword") ?? ShortName((string?)x.Attribute("cref") ?? ""),
                XElement x when x.Name == "paramref" || x.Name == "typeparamref" => (string?)x.Attribute("name") ?? "",
                XElement x when x.Name == "para" => " ",
                _ => "",
            })));
            foreach (var p in root.Elements("param")) {
                parameters[(string?)p.Attribute("name") ?? ""] = Flat(p);
            }
            return (Flat(root.Element("summary")), parameters);
        } catch (System.Xml.XmlException) {
            return ("", parameters);
        }
    }

    private static readonly SymbolDisplayFormat ParameterFormat = SymbolDisplayFormat.MinimallyQualifiedFormat
        .WithParameterOptions(SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName |
            SymbolDisplayParameterOptions.IncludeParamsRefOut | SymbolDisplayParameterOptions.IncludeDefaultValue);

    private async Task<object> SignaturesAsync(Request request, CancellationToken cancel)
    {
        var document = DocumentOf(request);
        var text = await document.GetTextAsync(cancel);
        var position = OffsetOf(text, request.Line, request.Column);
        var root = await document.GetSyntaxRootAsync(cancel);
        var model = await document.GetSemanticModelAsync(cancel);
        var empty = new {id = request.Id, signatures = Array.Empty<object>(), active = 0, parameter = 0};
        if (root == null || model == null) {
            return empty;
        }
        // The innermost argument list around the position, of a call or of new T(...).
        var token = root.FindToken(Math.Max(position - 1, 0));
        var arguments = token.Parent?.AncestorsAndSelf().OfType<ArgumentListSyntax>()
            .FirstOrDefault(a => a.OpenParenToken.Span.End <= position &&
                (a.CloseParenToken.IsMissing || position <= a.CloseParenToken.SpanStart));
        if (arguments == null) {
            return empty;
        }
        IEnumerable<IMethodSymbol> methods;
        ISymbol? chosen;
        switch (arguments.Parent) {
            case InvocationExpressionSyntax call:
                methods = model.GetMemberGroup(call.Expression, cancel).OfType<IMethodSymbol>();
                chosen = model.GetSymbolInfo(call, cancel).Symbol;
                break;
            case ObjectCreationExpressionSyntax creation:
                var type = model.GetTypeInfo(creation, cancel).Type as INamedTypeSymbol;
                methods = type?.InstanceConstructors.Where(c => c.DeclaredAccessibility == Accessibility.Public ||
                    SymbolEqualityComparer.Default.Equals(c.ContainingAssembly, model.Compilation.Assembly)) ??
                    Enumerable.Empty<IMethodSymbol>();
                chosen = model.GetSymbolInfo(creation, cancel).Symbol;
                break;
            default:
                return empty;
        }
        var list = methods.Distinct<IMethodSymbol>(SymbolEqualityComparer.Default).Take(40).ToList();
        if (list.Count == 0) {
            return empty;
        }
        var parameter = arguments.Arguments.GetSeparators().Count(s => s.SpanStart < position);
        var active = list.FindIndex(m => SymbolEqualityComparer.Default.Equals(m, chosen));
        if (active < 0) {
            active = Math.Max(0, list.FindIndex(m => m.Parameters.Length > parameter ||
                (m.Parameters.Length > 0 && m.Parameters[^1].IsParams)));
        }
        var signatures = list.Select(m => {
            var (summary, docs) = DocsOf(m);
            var name = m.MethodKind == MethodKind.Constructor ? m.ContainingType.Name : m.Name;
            var returns = m.MethodKind == MethodKind.Constructor ? "" :
                m.ReturnType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) + " ";
            var typeArgs = m.IsGenericMethod ? "<" + string.Join(", ", m.TypeArguments.Select(t =>
                t.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat))) + ">" : "";
            var parameters = m.Parameters.Select(p => new {
                label = p.ToDisplayString(ParameterFormat),
                doc = docs.TryGetValue(p.Name, out var d) ? d : "",
            }).ToList();
            return new {
                label = returns + name + typeArgs + "(" + string.Join(", ", parameters.Select(p => p.label)) + ")",
                doc = summary,
                parameters,
            };
        }).ToList();
        return new {id = request.Id, signatures, active, parameter};
    }

    private async Task<object> DiagnosticsAsync(Request request, CancellationToken cancel)
    {
        var document = DocumentOf(request);
        var compilation = await document.Project.GetCompilationAsync(cancel);
        if (compilation == null) {
            return new {id = request.Id, items = Array.Empty<object>()};
        }
        CultureInfo? culture = null;
        if (request.Culture != "") {
            try {
                culture = CultureInfo.GetCultureInfo(request.Culture);
            } catch (CultureNotFoundException) {
                culture = null;
            }
        }
        var items = compilation.GetDiagnostics(cancel)
            .Where(d => d.Severity >= DiagnosticSeverity.Warning && !d.IsSuppressed && d.Location.IsInSource)
            .Take(200)
            .Select(d => {
                var span = d.Location.GetLineSpan();
                return new {
                    file = span.Path,
                    severity = d.Severity == DiagnosticSeverity.Error ? "error" : "warning",
                    code = d.Id,
                    message = d.GetMessage(culture),
                    line = span.StartLinePosition.Line + 1,
                    column = span.StartLinePosition.Character + 1,
                    endLine = span.EndLinePosition.Line + 1,
                    endColumn = span.EndLinePosition.Character + 1,
                };
            }).ToList();
        return new {id = request.Id, items};
    }
}
