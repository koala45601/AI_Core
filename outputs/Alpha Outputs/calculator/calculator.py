def add(x, y):
    return x + y

def subtract(x, y):
    return x - y

def multiply(x, y):
    return x * y

def divide(x, y):
    if y == 0:
        return "ไม่สามารถหารด้วยศูนย์ได้"
    return x / y

# โปรแกรมหลัก
if __name__ == "__main__":
    print("=== เครื่องคิดเลขง่ายๆ ===")
    print("1. บวก")
    print("2. ลบ")
    print("3. คูณ")
    print("4. หาร")

    choice = input("เลือกการคำนวณ (1-4): ")

    if choice in ['1', '2', '3', '4']:
        try:
            num1 = float(input("กรุณากรอกตัวเลขที่ 1: "))
            num2 = float(input("กรุณากรอกตัวเลขที่ 2: "))
            
            if choice == '1':
                print(f"ผลลัพธ์: {add(num1, num2)}")
            elif choice == '2':
                print(f"ผลลัพธ์: {subtract(num1, num2)}")
            elif choice == '3':
                print(f"ผลลัพธ์: {multiply(num1, num2)}")
            elif choice == '4':
                print(f"ผลลัพธ์: {divide(num1, num2)}")
        except ValueError:
            print("ข้อมูลที่กรอกไม่ถูกต้อง โปรดกรอกตัวเลขเท่านั้น")
    else:
        print("การเลือกไม่ถูกต้อง โปรดเลือก 1-4")