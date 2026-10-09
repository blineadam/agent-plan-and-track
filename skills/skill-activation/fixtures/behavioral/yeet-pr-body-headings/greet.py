import argparse


def greeting(name):
    return f"Hello, {name}!"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Print a greeting.")
    parser.add_argument("name")
    args = parser.parse_args(argv)
    print(greeting(args.name))


if __name__ == "__main__":
    main()
