// A fixed installed reporter for an already admitted exact command. No caller obtains service credentials.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace Deszo.ControlHost {
    internal static class BoundedCommand {
        internal static int Run(){
            string document=Environment.GetEnvironmentVariable("DESZO_COMMAND_SPEC");
            Environment.SetEnvironmentVariable("DESZO_COMMAND_SPEC",null);
            if(document==null||document.Length>24000)throw new InvalidDataException("No bounded command specification.");
            var spec=Wire.Parse(document);string executable=Wire.Text(spec,"executable"),cwd=Wire.Text(spec,"cwd");
            if(!Path.IsPathRooted(executable)||!File.Exists(executable)||!Path.IsPathRooted(cwd))throw new UnauthorizedAccessException("An absolute exact executable and directory are required.");
            int timeout=Wire.Number(spec,"timeoutMs");if(timeout<1000||timeout>3600000)throw new InvalidDataException("Invalid command deadline.");
            var stdout=new StringBuilder();var stderr=new StringBuilder();bool truncated=false;var gate=new object();
            Action<TextReader,StringBuilder,ManualResetEvent> capture=delegate(TextReader reader,StringBuilder target,ManualResetEvent ended){try{var buffer=new char[4096];int count;while((count=reader.Read(buffer,0,buffer.Length))>0)lock(gate){int room=65536-target.Length;if(room>0)target.Append(buffer,0,Math.Min(room,count));if(count>room)truncated=true;}}catch{lock(gate)truncated=true;}finally{ended.Set();}};
            int exitCode;bool timedOut;
            using(var child=new Process()){
                child.StartInfo=new ProcessStartInfo(executable,Wire.Arguments(spec["arguments"])){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=cwd,RedirectStandardOutput=true,RedirectStandardError=true};
                child.Start();var outEnd=new ManualResetEvent(false);var errEnd=new ManualResetEvent(false);var outReader=child.StandardOutput;var errReader=child.StandardError;
                new Thread(delegate(){capture(outReader,stdout,outEnd);}){IsBackground=true}.Start();new Thread(delegate(){capture(errReader,stderr,errEnd);}){IsBackground=true}.Start();
                timedOut=!child.WaitForExit(timeout);
                if(timedOut){try{child.Kill();}catch{}if(!child.WaitForExit(5000))throw new TimeoutException("The command root did not terminate.");}
                // A descendant can keep redirected pipes open. It must not turn output draining into an unbounded wait.
                if(!outEnd.WaitOne(1000)||!errEnd.WaitOne(1000))truncated=true;
                exitCode=timedOut?124:child.ExitCode;
            }
            string digest;using(var hash=SHA256.Create())digest=Wire.Hex(hash.ComputeHash(Encoding.UTF8.GetBytes(document)));
            using(var api=new BrokerApi())api.Call("command.complete",new {operationId=Wire.Text(spec,"operationId"),specSha256=digest,exitCode=exitCode,timedOut=timedOut,stdout=stdout.ToString(),stderr=stderr.ToString(),captureTruncated=truncated});
            return exitCode;
        }
    }
}
