// The installed elevated broker displays host-owned bytes and delegates user verification to Windows WebAuthn.
// No PIN, biometric sample or credential private key crosses the service protocol.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace Deszo.ControlHost {
    internal static class HelloAuthenticator {
        [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] private struct Rp{internal uint version;internal string id,name,icon;}
        [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] private struct User{internal uint version,size;internal IntPtr id;internal string name,icon,display;}
        [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] private struct ClientData{internal uint version,size;internal IntPtr json;internal string algorithm;}
        [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] private struct Cose{internal uint version;internal string type;internal int algorithm;}
        [StructLayout(LayoutKind.Sequential)] private struct List{internal uint count;internal IntPtr values;}
        [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] private struct Credential{internal uint version,size;internal IntPtr id;internal string type;}
        [StructLayout(LayoutKind.Sequential)] private struct MakeOptions{internal uint version,timeout;internal List credentials,extensions;internal uint attachment;internal int resident;internal uint verification,attestation,flags;}
        [StructLayout(LayoutKind.Sequential)] private struct GetOptions{internal uint version,timeout;internal List credentials,extensions;internal uint attachment,verification,flags;}
        [StructLayout(LayoutKind.Sequential)] private struct Attestation{internal uint version;internal IntPtr format;internal uint authSize;internal IntPtr auth;internal uint size;internal IntPtr data;internal uint decode;internal IntPtr decoded;internal uint objectSize;internal IntPtr objectData;internal uint idSize;internal IntPtr id;}
        [StructLayout(LayoutKind.Sequential)] private struct Assertion{internal uint version,authSize;internal IntPtr auth;internal uint signatureSize;internal IntPtr signature;internal Credential credential;internal uint userSize;internal IntPtr user;}
        [DllImport("webauthn.dll")] private static extern uint WebAuthNGetApiVersionNumber();
        [DllImport("webauthn.dll")] private static extern int WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable([MarshalAs(UnmanagedType.Bool)]out bool available);
        [DllImport("webauthn.dll",CharSet=CharSet.Unicode)] private static extern int WebAuthNAuthenticatorMakeCredential(IntPtr window,ref Rp rp,ref User user,ref List parameters,ref ClientData client,ref MakeOptions options,out IntPtr result);
        [DllImport("webauthn.dll",CharSet=CharSet.Unicode)] private static extern int WebAuthNAuthenticatorGetAssertion(IntPtr window,string rpId,ref ClientData client,ref GetOptions options,out IntPtr result);
        [DllImport("webauthn.dll")] private static extern void WebAuthNFreeCredentialAttestation(IntPtr value);
        [DllImport("webauthn.dll")] private static extern void WebAuthNFreeAssertion(IntPtr value);
        private static byte[] Bytes(IntPtr value,uint size){if(size>Wire.Limit)throw new InvalidDataException("Authenticator data too large.");var bytes=new byte[size];if(size>0)Marshal.Copy(value,bytes,0,(int)size);return bytes;}
        private static IntPtr Allocate(byte[] value){IntPtr ptr=Marshal.AllocHGlobal(value.Length);Marshal.Copy(value,0,ptr,value.Length);return ptr;}
        internal static object Availability(){try{bool available;int result=WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable(out available);return new {apiVersion=WebAuthNGetApiVersionNumber(),platformAuthenticatorAvailable=result==0&&available,hresult=result};}catch(DllNotFoundException){return new {apiVersion=0,platformAuthenticatorAvailable=false,reason="webauthn_unavailable"};}}
        internal static object Create(IntPtr window,Dictionary<string,object> challenge){
            byte[] userId=Convert.FromBase64String(Wire.Text(challenge,"userIdBase64")),json=Encoding.UTF8.GetBytes(Wire.Text(challenge,"clientDataJSON"));
            IntPtr userPtr=Allocate(userId),jsonPtr=Allocate(json),cosePtr=IntPtr.Zero,result=IntPtr.Zero;
            try{var rp=new Rp{version=1,id="deszo.local",name="Deszo Local Control Host"};var user=new User{version=1,size=(uint)userId.Length,id=userPtr,name=Wire.Text(challenge,"userName"),display="Deszo autonomous development"};
                var cose=new Cose{version=1,type="public-key",algorithm=-7};cosePtr=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Cose)));Marshal.StructureToPtr(cose,cosePtr,false);var parameters=new List{count=1,values=cosePtr};
                var client=new ClientData{version=1,size=(uint)json.Length,json=jsonPtr,algorithm="SHA-256"};
                var options=new MakeOptions{version=1,timeout=120000,attachment=1,verification=1,attestation=1};
                int code=WebAuthNAuthenticatorMakeCredential(window,ref rp,ref user,ref parameters,ref client,ref options,out result);if(code!=0)Marshal.ThrowExceptionForHR(code);
                var value=(Attestation)Marshal.PtrToStructure(result,typeof(Attestation));
                return new {credentialId=Convert.ToBase64String(Bytes(value.id,value.idSize)),authenticatorData=Convert.ToBase64String(Bytes(value.auth,value.authSize)),attestationObject=Convert.ToBase64String(Bytes(value.objectData,value.objectSize)),clientDataJSON=Convert.ToBase64String(json)};
            }finally{if(result!=IntPtr.Zero)WebAuthNFreeCredentialAttestation(result);if(cosePtr!=IntPtr.Zero){Marshal.DestroyStructure(cosePtr,typeof(Cose));Marshal.FreeHGlobal(cosePtr);}Marshal.FreeHGlobal(userPtr);Marshal.FreeHGlobal(jsonPtr);}
        }
        internal static object Sign(IntPtr window,Dictionary<string,object> challenge){
            byte[] id=Convert.FromBase64String(Wire.Text(challenge,"credentialId")),json=Encoding.UTF8.GetBytes(Wire.Text(challenge,"clientDataJSON"));
            IntPtr idPtr=Allocate(id),jsonPtr=Allocate(json),credentialPtr=IntPtr.Zero,result=IntPtr.Zero;
            try{var credential=new Credential{version=1,size=(uint)id.Length,id=idPtr,type="public-key"};credentialPtr=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Credential)));Marshal.StructureToPtr(credential,credentialPtr,false);
                var client=new ClientData{version=1,size=(uint)json.Length,json=jsonPtr,algorithm="SHA-256"};
                var options=new GetOptions{version=1,timeout=120000,attachment=1,verification=1,credentials=new List{count=1,values=credentialPtr}};
                int code=WebAuthNAuthenticatorGetAssertion(window,"deszo.local",ref client,ref options,out result);if(code!=0)Marshal.ThrowExceptionForHR(code);
                var value=(Assertion)Marshal.PtrToStructure(result,typeof(Assertion));
                return new {credentialId=Convert.ToBase64String(Bytes(value.credential.id,value.credential.size)),authenticatorData=Convert.ToBase64String(Bytes(value.auth,value.authSize)),signature=Convert.ToBase64String(Bytes(value.signature,value.signatureSize)),clientDataJSON=Convert.ToBase64String(json)};
            }finally{if(result!=IntPtr.Zero)WebAuthNFreeAssertion(result);if(credentialPtr!=IntPtr.Zero){Marshal.DestroyStructure(credentialPtr,typeof(Credential));Marshal.FreeHGlobal(credentialPtr);}Marshal.FreeHGlobal(idPtr);Marshal.FreeHGlobal(jsonPtr);}
        }
    }
    internal sealed class BrokerApi : IDisposable {
        private NamedPipeClientStream pipe;private StreamReader reader;private StreamWriter writer;
        internal BrokerApi(){pipe=NativeClient.Connect();reader=new StreamReader(pipe,new UTF8Encoding(false),false,4096,true);writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true){AutoFlush=true};}
        internal Dictionary<string,object> Call(string method,object parameters){string id=Guid.NewGuid().ToString();writer.WriteLine(Wire.Json(new {id=id,method=method,@params=parameters}));
            while(true){var reply=Wire.Parse(Wire.ReadLine(reader));if(Wire.Text(reply,"id")!=id)continue;if(reply.ContainsKey("error"))throw new InvalidOperationException(Wire.Text(Wire.Map(reply,"error"),"message"));return Wire.Map(reply,"result");}}
        public void Dispose(){pipe.Dispose();}
    }
    internal sealed class BrokerForm : Form {
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool AllowSetForegroundWindow(int process);
        private sealed class PolicyRequestItem {
            internal Dictionary<string,object> Value;
            public override string ToString(){var policy=Wire.Map(Value,"decision");return "Policy "+Wire.Text(policy,"policyId")+" — original expiry "+Wire.Text(policy,"expiresAt");}
        }
        private readonly ComboBox requests=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,Dock=DockStyle.Top};
        private readonly TextBox decision=new TextBox{Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Both,WordWrap=false,Dock=DockStyle.Fill,Font=new Font("Consolas",10)};
        private readonly Label status=new Label{AutoSize=true,Dock=DockStyle.Bottom,MaximumSize=new Size(950,0)};
        private readonly Button approve=new Button{Text="Verify with Windows Hello",AutoSize=true};
        private readonly Button enroll=new Button{Text="Enroll Windows Hello",AutoSize=true};
        private Dictionary<string,object> selected;
        internal BrokerForm(){Text="Deszo — trusted autonomy consent";Width=1000;Height=760;StartPosition=FormStartPosition.CenterScreen;
            var buttons=new FlowLayoutPanel{Dock=DockStyle.Bottom,AutoSize=true};var refresh=new Button{Text="Refresh",AutoSize=true};var revoke=new Button{Text="Revoke and stop",AutoSize=true};var retire=new Button{Text="Retire credential",AutoSize=true};buttons.Controls.Add(refresh);buttons.Controls.Add(enroll);buttons.Controls.Add(approve);buttons.Controls.Add(revoke);buttons.Controls.Add(retire);
            Controls.Add(decision);Controls.Add(requests);Controls.Add(buttons);Controls.Add(status);
            refresh.Click+=delegate{Execute(RefreshState);};enroll.Click+=delegate{Execute(Enroll);};approve.Click+=delegate{Execute(Approve);};revoke.Click+=delegate{Execute(Revoke);};
            retire.Click+=delegate{Execute(Retire);};
            requests.SelectedIndexChanged+=delegate{var item=requests.SelectedItem as PolicyRequestItem;selected=item==null?null:item.Value;decision.Text=selected==null?"":Wire.Json(selected);};
            Shown+=delegate{Execute(RefreshState);};
            FormClosing+=delegate{ReturnForegroundToLauncher();};
        }
        private void ReturnForegroundToLauncher(){
            if(GetForegroundWindow()!=Handle)return;
            try{using(var api=new BrokerApi()){
                var result=api.Call("consent.launcher_identity",new {});var launcher=Wire.Map(result,"launcher");int pid=Wire.Number(launcher,"pid");if(pid<=0)return;
                IntPtr process=WindowsNative.OpenProcess(WindowsNative.Query|0x100000,false,pid);if(process==IntPtr.Zero)return;
                try{WindowsNative.Match(launcher,WindowsNative.InspectIdentity(pid));if(WindowsNative.WaitForSingleObject(process,0)==258&&GetForegroundWindow()==Handle)AllowSetForegroundWindow(pid);}
                finally{WindowsNative.CloseHandle(process);}
            }}catch(Exception){/* Closing is not authorization; failure never falls back to input or a new policy. */}
        }
        private void Execute(Action action){approve.Enabled=enroll.Enabled=false;try{if(!WindowsNative.DesktopAvailable())throw new InvalidOperationException("The interactive desktop is unavailable.");action();}catch(Exception error){status.Text="Blocked: "+error.Message;}finally{approve.Enabled=enroll.Enabled=true;}}
        private void RefreshState(){using(var api=new BrokerApi()){var state=api.Call("consent.overview",new {});requests.Items.Clear();object pending;if(state.TryGetValue("pending",out pending)&&pending is IEnumerable)foreach(object item in (IEnumerable)pending)requests.Items.Add(new PolicyRequestItem{Value=(Dictionary<string,object>)item});requests.DisplayMember="";if(requests.Items.Count>0)requests.SelectedIndex=0;status.Text=Wire.Json(state);}}
        private void Enroll(){using(var api=new BrokerApi()){var begin=api.Call("consent.enrollment.begin",new {});decision.Text=Wire.Json(begin);Refresh();
                object attestation=HelloAuthenticator.Create(Handle,begin);var challenge=api.Call("consent.enrollment.prepare",new {challengeId=begin["challengeId"],attestation=attestation});
                object assertion=HelloAuthenticator.Sign(Handle,challenge);var result=api.Call("consent.enrollment.finish",new {challengeId=challenge["challengeId"],assertion=assertion});status.Text=Wire.Json(result);}}
        private void Approve(){if(selected==null)throw new InvalidOperationException("Choose a pending host policy first.");using(var api=new BrokerApi()){
                var challenge=api.Call("consent.policy.challenge",new {challengeId=selected["challengeId"]});
                // Display exactly the decision fetched from the service, before calling the authenticator.
                decision.Text=Wire.Text(challenge,"displayText")??Wire.Json(challenge["decision"]);decision.Select(0,0);Refresh();
                var confirm=MessageBox.Show(this,"Verify the exact scope, budgets and original expiry displayed in this protected window. Continue with Windows Hello?","Deszo autonomous development",MessageBoxButtons.OKCancel,MessageBoxIcon.Information);
                if(confirm!=DialogResult.OK)throw new OperationCanceledException("Consent canceled.");
                object assertion=HelloAuthenticator.Sign(Handle,challenge);var result=api.Call("consent.policy.authorize",new {challengeId=challenge["challengeId"],displayedDecisionDigest=challenge["decisionDigest"],assertion=assertion});status.Text=Wire.Json(result);
                if(Wire.Text(result,"policyId")!=Wire.Text(Wire.Map(challenge,"decision"),"policyId")||Wire.Text(result,"state")!="active")throw new InvalidDataException("The committed consent receipt differs from the selected policy.");
                BeginInvoke(new Action(Close)); // Only after real WebAuthn + the matching committed receipt, never on cancel/error.
            }}
        private void Revoke(){using(var api=new BrokerApi()){var state=api.Call("consent.overview",new {});object policies;if(!state.TryGetValue("activePolicies",out policies))return;
                foreach(object item in (IEnumerable)policies){var policy=(Dictionary<string,object>)item;api.Call("consent.revoke",new {policyId=policy["policyId"]});}status.Text="Revocation committed; owned-work Stop requested.";}}
        private void Retire(){using(var api=new BrokerApi()){var challenge=api.Call("consent.retirement.begin",new {});decision.Text=Wire.Json(challenge["decision"]);Refresh();
            if(MessageBox.Show(this,"Retire this Windows Hello credential and revoke all autonomous policies? A replacement requires a new verified enrollment.","Deszo credential retirement",MessageBoxButtons.OKCancel,MessageBoxIcon.Warning)!=DialogResult.OK)throw new OperationCanceledException("Retirement canceled.");
            object assertion=HelloAuthenticator.Sign(Handle,challenge);status.Text=Wire.Json(api.Call("consent.retirement.finish",new {challengeId=challenge["challengeId"],displayedDecisionDigest=challenge["decisionDigest"],assertion=assertion}));}}
    }
    internal static class ConsentBroker {
        internal static int Run(){if(!new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator))throw new UnauthorizedAccessException("The protected broker must be started by its installed elevated task.");
            Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new BrokerForm());return 0;}
    }
}
