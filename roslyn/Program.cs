// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

// C# language service of the runner: reads one JSON request per line on stdin and writes one JSON answer per line on
// stdout, with the id of the request. Requests are handled in parallel; a request that takes too long is cancelled.
//
// @copyright  2026 Boban Blagojević
// @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later

using System.Text.Json;
using CodeLab.Roslyn;

var output = Console.OpenStandardOutput();
var gate = new object();
var options = new JsonSerializerOptions {PropertyNamingPolicy = JsonNamingPolicy.CamelCase};
var analyzer = new CSharpAnalyzer();

void Write(object answer)
{
    var bytes = JsonSerializer.SerializeToUtf8Bytes(answer, options);
    lock (gate) {
        output.Write(bytes);
        output.WriteByte((byte)'\n');
        output.Flush();
    }
}

// The first answer takes seconds (loading Roslyn and the references); do it before a reader waits for it.
_ = Task.Run(analyzer.WarmUpAsync);

string? line;
while ((line = Console.In.ReadLine()) != null) {
    Request? request;
    try {
        request = JsonSerializer.Deserialize<Request>(line, options);
    } catch (JsonException) {
        continue;
    }
    if (request == null) {
        continue;
    }
    _ = Task.Run(async () => {
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(6));
        object answer;
        try {
            answer = await analyzer.HandleAsync(request, cancel.Token);
        } catch (OperationCanceledException) {
            answer = new {id = request.Id, error = "timeout"};
        } catch (Exception e) {
            Console.Error.WriteLine($"{request.Op}: {e.GetType().Name}: {e.Message}");
            answer = new {id = request.Id, error = "analyzer"};
        }
        Write(answer);
    });
}
