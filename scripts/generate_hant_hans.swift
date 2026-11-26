import Foundation
var pairs:[String]=[]
for cp in 0x3400...0x9FFF { guard let u=Unicode.Scalar(cp) else{continue}; let s=String(Character(u))
  if let t=s.applyingTransform(StringTransform("Hant-Hans"),reverse:false), t != s, t.unicodeScalars.count==1 { pairs.append(s+t) } }
print(pairs.joined())
